import { IntentPurpose, Prisma } from "@prisma/client";
import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { audit } from "../../../utils/audit";
import { CsvColumn, streamCsv } from "../../../utils/csv";
import { parseRange } from "./finance.service";

/**
 * GET /admin/finance/export/<kind>.csv?from&to&includeTest - streamed CSVs.
 * Rows are read in createdAt/id order with keyset paging, so a 50,000-row file
 * costs 50 small queries and never a big OFFSET.
 */

type Range = { from?: Date; to?: Date };
type Keyed = { id: string; createdAt: Date };

const window = (range: Range) =>
  range.from || range.to
    ? { ...(range.from && { gte: range.from }), ...(range.to && { lte: range.to }) }
    : undefined;

/** Keyset paging after `after`, in (createdAt, id) order. */
const page = (after: Keyed | undefined, take: number) => ({
  take,
  orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
  ...(after && { cursor: { id: after.id }, skip: 1 }),
});

const bookings = (range: Range, includeTest: boolean) => {
  const where: Prisma.AppointmentWhereInput = {
    appointmentDate: window(range),
    ...(includeTest ? {} : { salon: { isTest: false } }),
  };
  const fetch = (after: Keyed | undefined, take: number) =>
    prisma.appointment.findMany({
      where,
      ...page(after, take),
      select: {
        id: true,
        token: true,
        createdAt: true,
        appointmentDate: true,
        startTime: true,
        status: true,
        totalMinor: true,
        depositMinor: true,
        depositStatus: true,
        commissionBps: true,
        cancelledBy: true,
        salon: { select: { name: true, area: true } },
        customer: { select: { name: true, email: true, phone: true } },
      },
    });
  type Row = Awaited<ReturnType<typeof fetch>>[number];
  const columns: CsvColumn<Row>[] = [
    { header: "Token", value: (r) => r.token },
    { header: "Booking ID", value: (r) => r.id },
    { header: "Created at", value: (r) => r.createdAt },
    { header: "Date", value: (r) => r.appointmentDate.toISOString().slice(0, 10) },
    { header: "Start", value: (r) => r.startTime },
    { header: "Status", value: (r) => r.status },
    { header: "Salon", value: (r) => r.salon.name },
    { header: "Area", value: (r) => r.salon.area },
    { header: "Customer", value: (r) => r.customer.name },
    { header: "Customer email", value: (r) => r.customer.email, pii: "email" },
    { header: "Customer phone", value: (r) => r.customer.phone, pii: "phone" },
    { header: "Total (BDT)", value: (r) => r.totalMinor, money: true },
    { header: "Deposit (BDT)", value: (r) => r.depositMinor, money: true },
    { header: "Deposit status", value: (r) => r.depositStatus },
    { header: "Commission (bps)", value: (r) => r.commissionBps },
    { header: "Cancelled by", value: (r) => r.cancelledBy },
  ];
  return { columns, fetch };
};

const ledger = (range: Range, includeTest: boolean) => {
  const where: Prisma.LedgerEntryWhereInput = {
    createdAt: window(range),
    ...(includeTest ? {} : { OR: [{ salonId: null }, { salon: { isTest: false } }] }),
  };
  const fetch = (after: Keyed | undefined, take: number) =>
    prisma.ledgerEntry.findMany({
      where,
      ...page(after, take),
      include: {
        salon: { select: { name: true } },
        appointment: { select: { token: true } },
      },
    });
  type Row = Awaited<ReturnType<typeof fetch>>[number];
  const columns: CsvColumn<Row>[] = [
    { header: "Entry ID", value: (r) => r.id },
    { header: "Created at", value: (r) => r.createdAt },
    { header: "Account", value: (r) => r.account },
    { header: "Amount (BDT)", value: (r) => r.amountMinor, money: true },
    { header: "Description", value: (r) => r.description },
    { header: "Salon", value: (r) => r.salon?.name },
    { header: "Booking token", value: (r) => r.appointment?.token },
    { header: "Booking ID", value: (r) => r.appointmentId },
    { header: "Payout ID", value: (r) => r.payoutId },
  ];
  return { columns, fetch };
};

const payouts = (range: Range, includeTest: boolean) => {
  const where: Prisma.PayoutWhereInput = {
    createdAt: window(range),
    ...(includeTest ? {} : { salon: { isTest: false } }),
  };
  const fetch = (after: Keyed | undefined, take: number) =>
    prisma.payout.findMany({
      where,
      ...page(after, take),
      include: { salon: { select: { name: true, area: true } } },
    });
  type Row = Awaited<ReturnType<typeof fetch>>[number];
  const columns: CsvColumn<Row>[] = [
    { header: "Payout ID", value: (r) => r.id },
    { header: "Created at", value: (r) => r.createdAt },
    { header: "Salon", value: (r) => r.salon.name },
    { header: "Area", value: (r) => r.salon.area },
    { header: "Period start", value: (r) => r.periodStart },
    { header: "Period end", value: (r) => r.periodEnd },
    { header: "Gross (BDT)", value: (r) => r.grossMinor, money: true },
    { header: "Commission (BDT)", value: (r) => r.commissionMinor, money: true },
    { header: "Net (BDT)", value: (r) => r.netMinor, money: true },
    { header: "Status", value: (r) => r.status },
    { header: "Method", value: (r) => r.method },
    { header: "Reference", value: (r) => r.reference },
    { header: "Proof URL", value: (r) => r.proofUrl },
    { header: "Paid at", value: (r) => r.paidAt },
    { header: "Failure reason", value: (r) => r.failureReason },
  ];
  return { columns, fetch };
};

const topups = (range: Range, includeTest: boolean) => {
  const where: Prisma.PaymentIntentWhereInput = {
    purpose: IntentPurpose.WALLET_TOPUP,
    createdAt: window(range),
    ...(includeTest ? {} : { user: { isTest: false } }),
  };
  const fetch = (after: Keyed | undefined, take: number) =>
    prisma.paymentIntent.findMany({
      where,
      ...page(after, take),
      select: {
        id: true,
        transactionId: true,
        createdAt: true,
        completedAt: true,
        provider: true,
        method: true,
        status: true,
        amountMinor: true,
        failureReason: true,
        user: { select: { name: true, email: true, phone: true } },
      },
    });
  type Row = Awaited<ReturnType<typeof fetch>>[number];
  const columns: CsvColumn<Row>[] = [
    { header: "Transaction ID", value: (r) => r.transactionId },
    { header: "Created at", value: (r) => r.createdAt },
    { header: "Completed at", value: (r) => r.completedAt },
    { header: "Provider", value: (r) => r.provider },
    { header: "Method", value: (r) => r.method },
    { header: "Status", value: (r) => r.status },
    { header: "Amount (BDT)", value: (r) => r.amountMinor, money: true },
    { header: "Customer", value: (r) => r.user.name },
    { header: "Customer email", value: (r) => r.user.email, pii: "email" },
    { header: "Customer phone", value: (r) => r.user.phone, pii: "phone" },
    { header: "Failure reason", value: (r) => r.failureReason },
  ];
  return { columns, fetch };
};

const users = (range: Range, includeTest: boolean) => {
  const where: Prisma.UserWhereInput = {
    isDeleted: false,
    createdAt: window(range),
    ...(includeTest ? {} : { isTest: false }),
  };
  const fetch = (after: Keyed | undefined, take: number) =>
    prisma.user.findMany({
      where,
      ...page(after, take),
      select: {
        id: true,
        createdAt: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        emailVerified: true,
        isTest: true,
        lastActiveAt: true,
      },
    });
  type Row = Awaited<ReturnType<typeof fetch>>[number];
  const columns: CsvColumn<Row>[] = [
    { header: "User ID", value: (r) => r.id },
    { header: "Joined", value: (r) => r.createdAt },
    { header: "Name", value: (r) => r.name },
    { header: "Email", value: (r) => r.email, pii: "email" },
    { header: "Phone", value: (r) => r.phone, pii: "phone" },
    { header: "Role", value: (r) => r.role },
    { header: "Status", value: (r) => r.status },
    { header: "Email verified", value: (r) => r.emailVerified },
    { header: "Test account", value: (r) => r.isTest },
    { header: "Last active", value: (r) => r.lastActiveAt },
  ];
  return { columns, fetch };
};

const KINDS = { bookings, ledger, payouts, topups, users } as const;
export type ExportKind = keyof typeof KINDS;

export const isExportKind = (kind: string): kind is ExportKind =>
  Object.prototype.hasOwnProperty.call(KINDS, kind);

export const exportCsv = async (req: Request, res: Response) => {
  const kind = String(req.params.file ?? "").replace(/\.csv$/i, "");
  if (!isExportKind(kind)) throw new ApiError(StatusCodes.NOT_FOUND, "Unknown export");
  if (kind === "users" && !req.admin?.permissions.includes("users.view")) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden");
  }

  const range = parseRange(req.query);
  const includeTest = req.query.includeTest === "true" || req.query.includeTest === "1";
  const { columns, fetch } = KINDS[kind](range, includeTest) as {
    columns: CsvColumn<unknown>[];
    fetch: (after: Keyed | undefined, take: number) => Promise<unknown[]>;
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const showPii = req.admin?.permissions.includes("users.view_pii") ?? false;

  const { rows, truncated } = await streamCsv(res, {
    filename: `${kind}-${stamp}.csv`,
    columns,
    showPii,
    fetchBatch: (after, take) => fetch(after as Keyed | undefined, take),
  });

  await audit(req.auditCtx, {
    action: "export.create",
    entityType: "export",
    entityId: kind,
    after: {
      kind,
      from: range.from?.toISOString() ?? null,
      to: range.to?.toISOString() ?? null,
      includeTest,
      pii: showPii,
      rows,
      truncated,
    },
  });
};
