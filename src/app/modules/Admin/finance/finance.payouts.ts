import { PayoutAccount, PayoutStatus, Prisma } from "@prisma/client";
import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { audit } from "../../../utils/audit";
import { CsvColumn, streamCsv } from "../../../utils/csv";
import { formatBDT } from "../../../utils/money";
import { revealNumber } from "../../Owner/owner.payoutAccount";
import { payoutNeedsApproval, SettlementService } from "../../Settlement/settlement.service";
import { realPayoutWhere } from "../../Settlement/settlement.buckets";
import { requestApproval } from "../approvals/approvals.service";

/**
 * The weekly payout desk: approve (four-eyes over approvals.payoutOverMinor),
 * processing, cancel, fail, bulk mark-paid with references, and the bKash /
 * BEFTN transfer files. Every move is one `transitionPayout`, so the legal
 * moves, the release of FAILED/CANCELLED entries and the owner emails stay in
 * one place.
 */

const short = (id: string) => id.slice(0, 8).toUpperCase();
/** What Finance puts in the transfer, and what the owner sees on their statement. */
export const payoutNote = (id: string) => `SK-PO-${short(id)}`;

const message = (error: unknown) =>
  error instanceof ApiError ? error.message : "Something went wrong with this payout";
const statusOf = (error: unknown) =>
  error instanceof ApiError ? error.statusCode : StatusCodes.INTERNAL_SERVER_ERROR;

export type PayoutItemResult =
  | { payoutId: string; ok: true; status: PayoutStatus | "APPROVAL_REQUIRED"; approvalId?: string }
  | { payoutId: string; ok: false; error: string; code: number };

// ---------------------------------------------------------------- approve

/**
 * One approval. Over the threshold (or every payout when it is unset) with
 * four-eyes on, it records an approval request instead: the second admin who
 * approves that request becomes the payout's approver.
 */
const approveOne = async (req: Request, id: string, reason?: string): Promise<PayoutItemResult> => {
  const payout = await SettlementService.assertPayable(id, { status: PayoutStatus.APPROVED });
  const why = reason?.trim() || `Approve payout ${short(id)}`;

  if (await payoutNeedsApproval(payout.netMinor)) {
    const approval = await requestApproval(req, "payout.approve", {
      payload: { payoutId: id, reason: why },
      summary: `Approve payout ${short(id)} (${formatBDT(payout.netMinor)})`,
      reason: why,
    });
    return { payoutId: id, ok: true, status: "APPROVAL_REQUIRED", approvalId: approval.id };
  }

  await SettlementService.transitionPayout(id, PayoutStatus.APPROVED, {}, { ctx: req.auditCtx, reason: why });
  return { payoutId: id, ok: true, status: PayoutStatus.APPROVED };
};

/** `POST /payouts/:id/approve` - one payout; errors throw. */
export const approvePayout = approveOne;

/** `POST /payouts/approve { ids }` - each its own move, one result per id. */
export const approvePayouts = async (req: Request, ids: string[], reason?: string) => {
  const results: PayoutItemResult[] = [];
  for (const id of ids) {
    try {
      results.push(await approveOne(req, id, reason));
    } catch (error) {
      results.push({ payoutId: id, ok: false, error: message(error), code: statusOf(error) });
    }
  }
  return results;
};

// ---------------------------------------------------------------- mark paid

export type MarkPaidItem = { payoutId: string; reference: string; method: "BKASH" | "BANK"; proofUrl?: string };

/**
 * `POST /payouts/mark-paid` - each item its own transaction, so one bad
 * reference does not hold back the rest. Four-eyes is the transition's own
 * check: a payout over the threshold must be APPROVED by someone else first.
 */
export const markPaid = async (req: Request, items: MarkPaidItem[], reason?: string) => {
  const seen = new Set<string>();
  const results: PayoutItemResult[] = [];
  for (const item of items) {
    const key = `${item.method}:${item.reference.trim().toLowerCase()}`;
    if (seen.has(item.payoutId) || seen.has(key)) {
      results.push({
        payoutId: item.payoutId,
        ok: false,
        error: seen.has(item.payoutId) ? "Listed twice" : "This reference is already used",
        code: StatusCodes.CONFLICT,
      });
      continue;
    }
    seen.add(item.payoutId);
    seen.add(key);
    try {
      const updated = await SettlementService.transitionPayout(
        item.payoutId,
        PayoutStatus.PAID,
        { method: item.method, reference: item.reference, proofUrl: item.proofUrl, markedPaidById: req.user!.userId },
        { ctx: req.auditCtx, reason: reason?.trim() || `Paid, ref ${item.reference.trim()}` },
      );
      results.push({ payoutId: item.payoutId, ok: true, status: updated.status });
    } catch (error) {
      results.push({ payoutId: item.payoutId, ok: false, error: message(error), code: statusOf(error) });
    }
  }
  return results;
};

// ---------------------------------------------------------------- export

export type PayoutFileFormat = "bkash" | "beftn";

type FileRow = {
  id: string;
  createdAt: Date;
  netMinor: number;
  account: PayoutAccount | null;
};

const BKASH_COLUMNS: CsvColumn<FileRow>[] = [
  { header: "payout_id", value: (r) => r.id },
  { header: "account_name", value: (r) => r.account?.accountName },
  { header: "wallet_number", value: (r) => (r.account ? revealNumber(r.account) : null) },
  { header: "amount_taka", value: (r) => r.netMinor, money: true },
  { header: "reference_note", value: (r) => payoutNote(r.id) },
];

const BEFTN_COLUMNS: CsvColumn<FileRow>[] = [
  { header: "payout_id", value: (r) => r.id },
  { header: "beneficiary_name", value: (r) => r.account?.accountName },
  { header: "bank_name", value: (r) => r.account?.bankName },
  { header: "branch_name", value: (r) => r.account?.branchName },
  { header: "routing_number", value: (r) => r.account?.routingNumber },
  { header: "account_number", value: (r) => (r.account ? revealNumber(r.account) : null) },
  { header: "amount_taka", value: (r) => r.netMinor, money: true },
  { header: "narration", value: (r) => `SalonKhuji payout ${payoutNote(r.id)}` },
];

const EXPORTABLE: PayoutStatus[] = [PayoutStatus.APPROVED, PayoutStatus.PROCESSING];

/**
 * `GET /payouts/export.csv?format=bkash|beftn&status=APPROVED[&ids=a,b]` -
 * the transfer file. Rows only for APPROVED/PROCESSING payouts whose snapshot
 * account is of that kind and is still VERIFIED (a replaced or disabled
 * account is left out: cancel and re-run that payout). Numbers are decrypted
 * row by row inside the stream and never cached; the audit records the size.
 */
export const exportPayoutFile = async (req: Request, res: Response) => {
  const format = String(req.query.format ?? "").toLowerCase() as PayoutFileFormat;
  if (format !== "bkash" && format !== "beftn") {
    throw new ApiError(StatusCodes.BAD_REQUEST, "format must be bkash or beftn");
  }
  const status = String(req.query.status ?? "APPROVED").toUpperCase() as PayoutStatus;
  if (!EXPORTABLE.includes(status)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Only APPROVED or PROCESSING payouts can be exported");
  }
  const ids =
    typeof req.query.ids === "string" && req.query.ids.trim()
      ? [...new Set(req.query.ids.split(",").map((s) => s.trim()).filter(Boolean))]
      : null;
  if (ids && ids.length > 200) throw new ApiError(StatusCodes.BAD_REQUEST, "At most 200 payouts per file");
  const includeTest = req.query.includeTest === "true" || req.query.includeTest === "1";

  const where: Prisma.PayoutWhereInput = {
    status,
    destinationSnapshot: { path: ["type"], equals: format === "bkash" ? "BKASH" : "BANK" },
    ...(ids ? { id: { in: ids } } : realPayoutWhere(includeTest)),
  };

  // Settle which payouts go in before streaming (no numbers read here), so
  // the keyset paging below never meets a row it has to drop.
  const candidates = await prisma.payout.findMany({ where, select: { id: true, payoutAccountId: true } });
  const verified = new Set(
    (
      await prisma.payoutAccount.findMany({
        where: {
          id: { in: candidates.map((c) => c.payoutAccountId).filter((id): id is string => !!id) },
          status: "VERIFIED",
        },
        select: { id: true },
      })
    ).map((a) => a.id),
  );
  const eligible = candidates
    .filter((c) => c.payoutAccountId && verified.has(c.payoutAccountId))
    .map((c) => c.id);
  const unverified = candidates.length - eligible.length;

  const stamp = new Date().toISOString().slice(0, 10);
  const { rows, truncated } = await streamCsv(res, {
    filename: `payouts-${format}-${stamp}.csv`,
    columns: format === "bkash" ? BKASH_COLUMNS : BEFTN_COLUMNS,
    // The file exists to send money: the numbers cannot be masked.
    showPii: true,
    fetchBatch: async (after, take): Promise<FileRow[]> => {
      const payouts = await prisma.payout.findMany({
        where: { id: { in: eligible } },
        take,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...(after && { cursor: { id: after.id }, skip: 1 }),
        select: { id: true, createdAt: true, netMinor: true, payoutAccountId: true },
      });
      const accounts = await prisma.payoutAccount.findMany({
        where: { id: { in: payouts.map((p) => p.payoutAccountId!) } },
      });
      const byId = new Map(accounts.map((a) => [a.id, a]));
      return payouts.map((p) => ({
        id: p.id,
        createdAt: p.createdAt,
        netMinor: p.netMinor,
        account: byId.get(p.payoutAccountId!) ?? null,
      }));
    },
  });

  await audit(req.auditCtx, {
    action: "export.create",
    entityType: "export",
    entityId: `payouts-${format}`,
    after: { kind: `payouts-${format}`, status, ids: ids?.length ?? null, includeTest, rows, truncated, unverified },
  });
};
