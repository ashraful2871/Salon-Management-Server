import { KycStatus, PayoutAccountStatus, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../../config";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { AuditCtx, auditTx } from "../../../utils/audit";
import { notifyOwner } from "../../../utils/notify";
import {
  getKycDecisionTemplate,
  getPayoutAccountDecisionTemplate,
} from "../../../utils/emailTemplates";
import { describeAccount, maskAccount, revealNumber } from "../../Owner/owner.payoutAccount";

/**
 * Finance's review queue for payout accounts and business KYC. Verifying a new
 * account retires the old VERIFIED one in the same transaction, so a business
 * has at most one destination at any time. Full numbers come only from
 * `reveal` (users.view_pii, audited).
 */

const ACCOUNT_STATUSES = Object.values(PayoutAccountStatus) as string[];
const KYC_STATUSES = Object.values(KycStatus) as string[];

const settingsUrl = () => `${config.frontend_url}/dashboard/money/payout-settings`;

const OWNER_SELECT = {
  id: true,
  businessName: true,
  businessEmail: true,
  legalName: true,
  tradeLicenseNo: true,
  tin: true,
  bin: true,
  nidLast4: true,
  kycStatus: true,
  kycNote: true,
  payoutsFrozen: true,
  user: { select: { id: true, name: true, email: true, isTest: true } },
} satisfies Prisma.SalonOwnerSelect;

type OwnerRow = Prisma.SalonOwnerGetPayload<{ select: typeof OWNER_SELECT }>;

const ownerView = (owner: OwnerRow) => ({
  id: owner.id,
  businessName: owner.businessName || owner.user.name,
  ownerName: owner.user.name,
  email: owner.user.email,
  isTest: owner.user.isTest,
  payoutsFrozen: owner.payoutsFrozen,
  kyc: {
    legalName: owner.legalName,
    tradeLicenseNo: owner.tradeLicenseNo,
    tin: owner.tin,
    bin: owner.bin,
    nidLast4: owner.nidLast4,
    status: owner.kycStatus,
    note: owner.kycNote,
  },
});

const paging = (query: Record<string, unknown>) => {
  const page = Math.max(1, Number.parseInt(String(query.page ?? 1), 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(query.limit ?? 20), 10) || 20));
  return { page, limit };
};

/** GET /admin/finance/payout-accounts?status= (masked). */
const listAccounts = async (query: Record<string, unknown>) => {
  const status =
    typeof query.status === "string" ? query.status.toUpperCase() : "PENDING_VERIFICATION";
  if (!ACCOUNT_STATUSES.includes(status)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `Unknown status "${query.status}"`);
  }
  const { page, limit } = paging(query);
  const where: Prisma.PayoutAccountWhereInput = { status: status as PayoutAccountStatus };

  const [rows, total, counts, kycPending] = await Promise.all([
    prisma.payoutAccount.findMany({
      where,
      // The queue is oldest first; history newest first.
      orderBy: { createdAt: status === "PENDING_VERIFICATION" ? "asc" : "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: { owner: { select: OWNER_SELECT } },
    }),
    prisma.payoutAccount.count({ where }),
    prisma.payoutAccount.groupBy({ by: ["status"], _count: true }),
    prisma.salonOwner.count({ where: { kycStatus: KycStatus.SUBMITTED } }),
  ]);

  // The account each owner is paid to today, for "replaces …" in the sheet.
  const current = await prisma.payoutAccount.findMany({
    where: {
      ownerId: { in: [...new Set(rows.map((r) => r.ownerId))] },
      status: PayoutAccountStatus.VERIFIED,
    },
  });
  const currentOf = new Map(current.map((a) => [a.ownerId, a]));

  return {
    meta: { page, limit, total },
    data: {
      statusCounts: Object.fromEntries(
        ACCOUNT_STATUSES.map((s) => [s, counts.find((c) => c.status === s)?._count ?? 0]),
      ),
      kycSubmitted: kycPending,
      items: rows.map(({ owner, ...row }) => {
        const replaces = currentOf.get(row.ownerId);
        return {
          ...maskAccount(row),
          owner: ownerView(owner),
          replaces: replaces && replaces.id !== row.id ? maskAccount(replaces) : null,
        };
      }),
    },
  };
};

/** GET /admin/finance/kyc?status= - businesses by KYC status (default SUBMITTED). */
const listKyc = async (query: Record<string, unknown>) => {
  const status = typeof query.status === "string" ? query.status.toUpperCase() : "SUBMITTED";
  if (!KYC_STATUSES.includes(status)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `Unknown status "${query.status}"`);
  }
  const { page, limit } = paging(query);
  const where: Prisma.SalonOwnerWhereInput = { kycStatus: status as KycStatus };
  const [rows, total] = await Promise.all([
    prisma.salonOwner.findMany({
      where,
      orderBy: { updatedAt: status === "SUBMITTED" ? "asc" : "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        ...OWNER_SELECT,
        updatedAt: true,
        payoutAccounts: { where: { status: PayoutAccountStatus.VERIFIED }, take: 1 },
      },
    }),
    prisma.salonOwner.count({ where }),
  ]);
  return {
    meta: { page, limit, total },
    data: rows.map(({ payoutAccounts, updatedAt, ...owner }) => ({
      ...ownerView(owner),
      submittedAt: updatedAt,
      account: payoutAccounts[0] ? maskAccount(payoutAccounts[0]) : null,
    })),
  };
};

const loadAccount = async (id: string, db: Prisma.TransactionClient = prisma) => {
  const row = await db.payoutAccount.findUnique({
    where: { id },
    include: { owner: { select: OWNER_SELECT } },
  });
  if (!row) throw new ApiError(StatusCodes.NOT_FOUND, "Payout account not found");
  return row;
};

/** GET /admin/finance/payout-accounts/:id/reveal - the full number, audited. */
const reveal = async (ctx: AuditCtx | undefined, id: string) => {
  const row = await loadAccount(id);
  const number = revealNumber(row);
  await prisma.$transaction((tx) =>
    auditTx(tx, ctx, {
      action: "payout_account.reveal",
      entityType: "payout_account",
      entityId: row.id,
      after: { ownerId: row.ownerId, account: describeAccount(row) },
    }),
  );
  return { id: row.id, number };
};

/** Verify or reject a PENDING_VERIFICATION account; verify retires the old one. */
const decideAccount = async (
  ctx: AuditCtx | undefined,
  adminUserId: string,
  id: string,
  decision: { verified: true } | { verified: false; reason: string },
) => {
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const row = await loadAccount(id, tx);
    if (row.status !== PayoutAccountStatus.PENDING_VERIFICATION) {
      throw new ApiError(StatusCodes.CONFLICT, `This account is already ${row.status.toLowerCase().replace("_", " ")}`);
    }

    const claimed = await tx.payoutAccount.updateMany({
      where: { id, status: PayoutAccountStatus.PENDING_VERIFICATION },
      data: decision.verified
        ? { status: PayoutAccountStatus.VERIFIED, verifiedById: adminUserId, verifiedAt: now, rejectionReason: null }
        : { status: PayoutAccountStatus.REJECTED, rejectionReason: decision.reason },
    });
    if (claimed.count === 0) {
      throw new ApiError(StatusCodes.CONFLICT, "This account changed meanwhile - reload and try again");
    }

    let retired: string[] = [];
    if (decision.verified) {
      const old = await tx.payoutAccount.findMany({
        where: { ownerId: row.ownerId, status: PayoutAccountStatus.VERIFIED, id: { not: id } },
        select: { id: true },
      });
      retired = old.map((a) => a.id);
      if (retired.length > 0) {
        await tx.payoutAccount.updateMany({
          where: { id: { in: retired } },
          data: { status: PayoutAccountStatus.DISABLED },
        });
      }
    }

    await auditTx(tx, ctx, {
      action: decision.verified ? "payout_account.verify" : "payout_account.reject",
      entityType: "payout_account",
      entityId: id,
      before: { status: row.status },
      after: {
        status: decision.verified ? "VERIFIED" : "REJECTED",
        ownerId: row.ownerId,
        account: describeAccount(row),
        ...(retired.length ? { disabled: retired } : {}),
      },
      reason: decision.verified ? null : decision.reason,
    });

    return { row, retired };
  });

  const { row } = result;
  const accountSubject = decision.verified ? "Your payout account is verified" : "Your payout account was not approved";
  await notifyOwner(row.ownerId, decision.verified ? "payout_account.verified" : "payout_account.rejected", {
    title: accountSubject,
    body: decision.verified
      ? `${describeAccount(row)} will receive your payouts.`
      : `${describeAccount(row)}: ${decision.reason}`,
    link: "/dashboard/money/payout-settings",
    dedupeKey: `${decision.verified ? "payout_account.verified" : "payout_account.rejected"}:${row.id}`,
    email: {
      subject: accountSubject,
      html: (ownerName) =>
        getPayoutAccountDecisionTemplate({
          ownerName,
          account: describeAccount(row),
          verified: decision.verified,
          reason: decision.verified ? null : decision.reason,
          settingsUrl: settingsUrl(),
        }),
    },
  });

  const fresh = await prisma.payoutAccount.findUniqueOrThrow({ where: { id } });
  return { ...maskAccount(fresh), disabled: result.retired.length };
};

/** Verify or reject a business's SUBMITTED KYC. */
const decideKyc = async (
  ctx: AuditCtx | undefined,
  ownerId: string,
  decision: { verified: true } | { verified: false; reason: string },
) => {
  const owner = await prisma.$transaction(async (tx) => {
    const claimed = await tx.salonOwner.updateMany({
      where: { id: ownerId, kycStatus: KycStatus.SUBMITTED },
      data: decision.verified
        ? { kycStatus: KycStatus.VERIFIED, kycNote: null }
        : { kycStatus: KycStatus.REJECTED, kycNote: decision.reason },
    });
    if (claimed.count === 0) {
      const exists = await tx.salonOwner.findUnique({ where: { id: ownerId }, select: { kycStatus: true } });
      if (!exists) throw new ApiError(StatusCodes.NOT_FOUND, "Business not found");
      throw new ApiError(StatusCodes.CONFLICT, `KYC is ${exists.kycStatus.toLowerCase()}, not awaiting review`);
    }
    await auditTx(tx, ctx, {
      action: decision.verified ? "owner.kyc_verify" : "owner.kyc_reject",
      entityType: "salon_owner",
      entityId: ownerId,
      before: { kycStatus: "SUBMITTED" },
      after: { kycStatus: decision.verified ? "VERIFIED" : "REJECTED" },
      reason: decision.verified ? null : decision.reason,
    });
    return tx.salonOwner.findUniqueOrThrow({ where: { id: ownerId }, select: OWNER_SELECT });
  });

  // KYC rides on the payout-account events: it is part of getting paid.
  const kycSubject = decision.verified ? "Your business details are verified" : "Your business details need changes";
  await notifyOwner(ownerId, decision.verified ? "payout_account.verified" : "payout_account.rejected", {
    title: kycSubject,
    body: decision.verified ? "Finance verified your business details." : `Finance asked for changes: ${decision.reason}`,
    link: "/dashboard/money/payout-settings",
    email: {
      subject: kycSubject,
      html: (ownerName) =>
        getKycDecisionTemplate({
          ownerName,
          verified: decision.verified,
          reason: decision.verified ? null : decision.reason,
          settingsUrl: settingsUrl(),
        }),
    },
  });

  return ownerView(owner);
};

export const PayoutAccountReview = { listAccounts, listKyc, reveal, decideAccount, decideKyc };
