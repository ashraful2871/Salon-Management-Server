import { LedgerAccount, PayoutStatus, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { audit, AuditCtx } from "../../../utils/audit";
import { getPlatformEarnings } from "../../Settlement/settlement.earnings";
import { SettlementService } from "../../Settlement/settlement.service";
import { getLastReconcileAt } from "../../Payment/paymentIntent.service";
import { WalletService } from "../../Wallet/wallet.service";
import { AdminContext } from "../admin.middleware";
import { maskEmail, maskPhone } from "../admin.service";

const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------- range

/**
 * `from` / `to` as `YYYY-MM-DD` (Dhaka days, what the date chips write) or
 * full ISO. A bare `to` date means the end of that day.
 */
export const parseRange = (query: Record<string, unknown>) => {
  const read = (value: unknown, endOfDay: boolean) => {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const bare = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
    const date = bare
      ? new Date(`${value.trim()}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+06:00`)
      : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new ApiError(StatusCodes.BAD_REQUEST, `"${value}" is not a date`);
    }
    return date;
  };
  const from = read(query.from, false);
  const to = read(query.to, true);
  if (from && to && from > to) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "The start date is after the end date");
  }
  return { from, to };
};

const flag = (value: unknown) => value === "true" || value === "1";

// ---------------------------------------------------------------- overview

const reconciliationCounts = async () => {
  const [unbalanced, drift, stuckIntents, lastAudit] = await Promise.all([
    SettlementService.findUnbalancedAppointments(),
    WalletService.findDrift(),
    prisma.paymentIntent.count({
      where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - HOUR) } },
    }),
    prisma.auditLog.findFirst({
      where: { action: "reconcile.run" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  // The job does not audit; this process remembers its own last run.
  const inProcess = getLastReconcileAt();
  const manual = lastAudit?.createdAt ?? null;
  const lastReconcileAt =
    inProcess && manual ? (inProcess > manual ? inProcess : manual) : (inProcess ?? manual);

  return {
    unbalancedCount: unbalanced.length,
    driftCount: drift.length,
    stuckIntents,
    lastReconcileAt,
  };
};

const overview = async (query: Record<string, unknown>) => {
  const range = parseRange(query);
  const [earnings, reconciliation] = await Promise.all([
    getPlatformEarnings({ ...range, includeTest: flag(query.includeTest) }),
    reconciliationCounts(),
  ]);
  return { range, earnings, reconciliation };
};

/** The ledger page's two lists, with names attached. */
const reconciliation = async () => {
  const [unbalanced, drift, counts] = await Promise.all([
    SettlementService.findUnbalancedAppointments(),
    WalletService.findDrift(),
    reconciliationCounts(),
  ]);

  const [appointments, users] = await Promise.all([
    prisma.appointment.findMany({
      where: { id: { in: unbalanced.map((row) => row.appointmentId) } },
      select: { id: true, token: true, appointmentDate: true, salon: { select: { name: true } } },
    }),
    prisma.user.findMany({
      where: { id: { in: drift.map((row) => row.userId) } },
      select: { id: true, name: true, email: true },
    }),
  ]);
  const apptById = new Map(appointments.map((a) => [a.id, a]));
  const userById = new Map(users.map((u) => [u.id, u]));

  return {
    ...counts,
    unbalanced: unbalanced.map((row) => {
      const appt = apptById.get(row.appointmentId);
      return {
        appointmentId: row.appointmentId,
        token: appt?.token ?? null,
        salonName: appt?.salon.name ?? null,
        appointmentDate: appt?.appointmentDate ?? null,
        totalMinor: row.total,
      };
    }),
    drift: drift.map((row) => ({
      walletId: row.walletId,
      userId: row.userId,
      name: userById.get(row.userId)?.name ?? null,
      email: maskEmail(userById.get(row.userId)?.email),
      balanceMinor: row.balance,
      ledgerBalanceMinor: row.ledgerBalance,
      heldBalanceMinor: row.heldBalance,
      diffMinor: row.balance - row.ledgerBalance,
    })),
  };
};

// ---------------------------------------------------------------- payouts

const PAYOUT_STATUSES = Object.values(PayoutStatus) as string[];

const listPayouts = async (query: Record<string, unknown>) => {
  const status = typeof query.status === "string" ? query.status.toUpperCase() : "PENDING";
  if (!PAYOUT_STATUSES.includes(status)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `Unknown status "${query.status}"`);
  }
  const page = Math.max(1, Number.parseInt(String(query.page ?? 1), 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(query.limit ?? 20), 10) || 20));
  const where: Prisma.PayoutWhereInput = {
    status: status as PayoutStatus,
    ...(flag(query.includeTest) ? {} : { salon: { isTest: false } }),
  };

  const [rows, total, counts] = await Promise.all([
    prisma.payout.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: { salon: { select: { id: true, name: true, area: true, phone: true } } },
    }),
    prisma.payout.count({ where }),
    prisma.payout.groupBy({
      by: ["status"],
      where: flag(query.includeTest) ? {} : { salon: { isTest: false } },
      _count: true,
      _sum: { netMinor: true },
    }),
  ]);

  const markers = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.markedPaidById).filter((id): id is string => !!id) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(markers.map((m) => [m.id, m.name]));

  return {
    meta: { page, limit, total },
    data: {
      statusCounts: Object.fromEntries(
        PAYOUT_STATUSES.map((s) => {
          const row = counts.find((c) => c.status === s);
          return [s, { count: row?._count ?? 0, netMinor: row?._sum.netMinor ?? 0 }];
        }),
      ),
      items: rows.map((row) => ({
        ...row,
        markedPaidBy: row.markedPaidById
          ? { id: row.markedPaidById, name: nameOf.get(row.markedPaidById) ?? null }
          : null,
      })),
    },
  };
};

// ---------------------------------------------------------------- wallets

const walletCard = (wallet: { balance: number; heldBalance: number; isFrozen: boolean } | null) => ({
  balanceMinor: wallet?.balance ?? 0,
  heldMinor: wallet?.heldBalance ?? 0,
  availableMinor: (wallet?.balance ?? 0) - (wallet?.heldBalance ?? 0),
  isFrozen: wallet?.isFrozen ?? false,
  exists: Boolean(wallet),
});

const searchWallets = async (admin: AdminContext, query: Record<string, unknown>) => {
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  if (q.length < 2) return [];

  const contains = { contains: q, mode: "insensitive" as const };
  const users = await prisma.user.findMany({
    where: {
      isDeleted: false,
      OR: [{ id: q }, { email: contains }, { phone: contains }, { name: contains }],
    },
    take: 20,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      isTest: true,
      wallet: { select: { balance: true, heldBalance: true, isFrozen: true } },
    },
  });

  const pii = admin.permissions.includes("users.view_pii");
  return users.map((user) => ({
    userId: user.id,
    name: user.name,
    email: pii ? user.email : maskEmail(user.email),
    phone: pii ? user.phone : maskPhone(user.phone),
    role: user.role,
    isTest: user.isTest,
    wallet: walletCard(user.wallet),
  }));
};

const walletDetail = async (
  admin: AdminContext,
  userId: string,
  query: Record<string, unknown>,
) => {
  const user = await prisma.user.findFirst({
    where: { id: userId, isDeleted: false },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      isTest: true,
      wallet: { select: { id: true, balance: true, heldBalance: true, isFrozen: true } },
    },
  });
  if (!user) throw new ApiError(StatusCodes.NOT_FOUND, "User not found");

  const page = Math.max(1, Number.parseInt(String(query.page ?? 1), 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(query.limit ?? 25), 10) || 25));

  const [rows, total] = user.wallet
    ? await Promise.all([
        prisma.walletTransaction.findMany({
          where: { walletId: user.wallet.id },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.walletTransaction.count({ where: { walletId: user.wallet.id } }),
      ])
    : [[], 0];

  const pii = admin.permissions.includes("users.view_pii");
  return {
    meta: { page, limit, total },
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: pii ? user.email : maskEmail(user.email),
        phone: pii ? user.phone : maskPhone(user.phone),
        role: user.role,
        isTest: user.isTest,
      },
      wallet: walletCard(user.wallet),
      self: user.id === admin.userId,
      transactions: rows.map(WalletService.serializeTransaction),
    },
  };
};

/**
 * Freeze or unfreeze a wallet. Only the flag changes - no money moves, so
 * this is not a `mutate` call; `mutate` is what enforces it (only an
 * ADJUSTMENT gets through a frozen wallet).
 */
const setFrozen = async (
  admin: AdminContext,
  ctx: AuditCtx | undefined,
  userId: string,
  body: { frozen: boolean; reason: string },
) => {
  if (userId === admin.userId) {
    throw new ApiError(StatusCodes.FORBIDDEN, "You can't freeze or unfreeze your own wallet");
  }
  const user = await prisma.user.findFirst({ where: { id: userId, isDeleted: false }, select: { id: true } });
  if (!user) throw new ApiError(StatusCodes.NOT_FOUND, "User not found");

  const wallet = await WalletService.getOrCreateWallet(userId);
  if (wallet.isFrozen === body.frozen) {
    return walletCard(wallet);
  }

  const updated = await prisma.wallet.update({
    where: { id: wallet.id },
    data: { isFrozen: body.frozen },
  });

  await audit(ctx, {
    action: body.frozen ? "wallet.freeze" : "wallet.unfreeze",
    entityType: "wallet",
    entityId: userId,
    before: { isFrozen: wallet.isFrozen },
    after: { isFrozen: updated.isFrozen },
    reason: body.reason,
  });

  return walletCard(updated);
};

// ---------------------------------------------------------------- ledger

const LEDGER_ACCOUNTS = Object.values(LedgerAccount) as string[];
const LEDGER_PAGE = 50;

const ledger = async (query: Record<string, unknown>) => {
  const range = parseRange(query);
  const where: Prisma.LedgerEntryWhereInput = {};

  if (typeof query.account === "string" && query.account) {
    const accounts = query.account.toUpperCase().split(",");
    if (accounts.some((a) => !LEDGER_ACCOUNTS.includes(a))) {
      throw new ApiError(StatusCodes.BAD_REQUEST, `Unknown account "${query.account}"`);
    }
    where.account = { in: accounts as LedgerAccount[] };
  }
  for (const key of ["salonId", "appointmentId", "payoutId"] as const) {
    const value = query[key];
    if (typeof value === "string" && value) where[key] = value;
  }
  if (range.from || range.to) {
    where.createdAt = { ...(range.from && { gte: range.from }), ...(range.to && { lte: range.to }) };
  }

  const cursor = typeof query.cursor === "string" && query.cursor ? query.cursor : undefined;
  const rows = await prisma.ledgerEntry.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LEDGER_PAGE + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    include: {
      salon: { select: { id: true, name: true } },
      appointment: { select: { id: true, token: true } },
    },
  });

  const hasMore = rows.length > LEDGER_PAGE;
  const items = hasMore ? rows.slice(0, LEDGER_PAGE) : rows;
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
};

export const AdminFinanceService = {
  overview,
  reconciliation,
  listPayouts,
  searchWallets,
  walletDetail,
  setFrozen,
  ledger,
};
