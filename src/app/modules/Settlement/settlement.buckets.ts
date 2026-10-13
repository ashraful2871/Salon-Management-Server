import { LedgerAccount, PayoutStatus, Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";
import { getSetting } from "../../utils/settings";

/**
 * Where a business's SALON_PAYABLE money sits. Every row is in exactly one
 * bucket, so the four buckets always sum to the business's SALON_PAYABLE:
 *
 *   pending    - not in a payout, younger than payouts.holdDays
 *   available  - not in a payout, past the hold: the next run takes it
 *   inPayout   - on a PENDING / APPROVED / PROCESSING payout
 *   paid       - on a PAID payout
 *
 * FAILED and CANCELLED payouts release their rows, so those are back in
 * pending/available. A negative pending + available is dues: the business
 * owes the platform (commission on cash it collected itself).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

/** Entries younger than the hold are pending; a payout only takes older ones. */
export const holdCutoff = (holdDays: number, now = new Date()) =>
  new Date(now.getTime() - holdDays * DAY_MS);

/** The next `weekday` (0 = Sunday) at 09:00 Asia/Dhaka, strictly after `now`. */
export const nextPayoutDate = (weekday: number, now = new Date()) => {
  // UTC fields of `local` read as the Dhaka wall clock (no DST in Dhaka).
  const local = new Date(now.getTime() + DHAKA_OFFSET_MS);
  const todayAtNine =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 9) -
    DHAKA_OFFSET_MS;
  let days = (weekday - local.getUTCDay() + 7) % 7;
  if (days === 0 && now.getTime() >= todayAtNine) days = 7;
  return new Date(todayAtNine + days * DAY_MS);
};

export const IN_PAYOUT: PayoutStatus[] = [
  PayoutStatus.PENDING,
  PayoutStatus.APPROVED,
  PayoutStatus.PROCESSING,
];

type Buckets = {
  pendingMinor: number;
  availableMinor: number;
  inPayoutMinor: number;
  paidMinor: number;
  duesMinor: number;
};

const emptyBuckets = (): Buckets => ({
  pendingMinor: 0,
  availableMinor: 0,
  inPayoutMinor: 0,
  paidMinor: 0,
  duesMinor: 0,
});

const withDues = (b: Buckets): Buckets => ({
  ...b,
  duesMinor: Math.max(0, -(b.pendingMinor + b.availableMinor)),
});

/**
 * The four buckets per salon for SALON_PAYABLE rows matching `scope`. One
 * groupBy per bucket, run together.
 */
const bucketsBySalon = async (
  scope: Prisma.LedgerEntryWhereInput,
  cutoff: Date,
  db: Prisma.TransactionClient = prisma,
) => {
  const where = { ...scope, account: LedgerAccount.SALON_PAYABLE };
  const group = (extra: Prisma.LedgerEntryWhereInput) =>
    db.ledgerEntry.groupBy({
      by: ["salonId"],
      where: { ...where, ...extra },
      _sum: { amountMinor: true },
    });

  const [pending, available, inPayout, paid] = await Promise.all([
    group({ payoutId: null, createdAt: { gt: cutoff } }),
    group({ payoutId: null, createdAt: { lte: cutoff } }),
    group({ payout: { status: { in: IN_PAYOUT } } }),
    group({ payout: { status: PayoutStatus.PAID } }),
  ]);

  const bySalon = new Map<string | null, Buckets>();
  const add = (rows: typeof pending, key: keyof Buckets) => {
    for (const row of rows) {
      const b = bySalon.get(row.salonId) ?? emptyBuckets();
      b[key] += row._sum.amountMinor ?? 0;
      bySalon.set(row.salonId, b);
    }
  };
  add(pending, "pendingMinor");
  add(available, "availableMinor");
  add(inPayout, "inPayoutMinor");
  add(paid, "paidMinor");

  return bySalon;
};

/** Unpaid balance per salon (available + pending), for many salons at once. */
export const salonBalances = async (salonIds: string[]) => {
  if (salonIds.length === 0) return [];
  const cutoff = holdCutoff(await getSetting("payouts.holdDays"));
  const bySalon = await bucketsBySalon({ salonId: { in: salonIds } }, cutoff);

  return salonIds.map((salonId) => {
    const b = bySalon.get(salonId) ?? emptyBuckets();
    return {
      salonId,
      payableMinor: b.availableMinor + b.pendingMinor,
      availableMinor: b.availableMinor,
      pendingMinor: b.pendingMinor,
    };
  });
};

/**
 * One business's money, total and per salon. `salonId` narrows it to one
 * branch (the caller has already checked access).
 */
export const getOwnerBuckets = async (
  ownerId: string,
  opts: { salonId?: string; db?: Prisma.TransactionClient } = {},
) => {
  const db = opts.db ?? prisma;
  const [holdDays, minMinor, weekday] = await Promise.all([
    getSetting("payouts.holdDays"),
    getSetting("payouts.minMinor"),
    getSetting("payouts.weekday"),
  ]);
  const now = new Date();
  const bySalon = await bucketsBySalon(
    { ownerId, ...(opts.salonId ? { salonId: opts.salonId } : {}) },
    holdCutoff(holdDays, now),
    db,
  );

  const salonIds = [...bySalon.keys()].filter((id): id is string => !!id);
  const salons = salonIds.length
    ? await db.salon.findMany({
        where: { id: { in: salonIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(salons.map((salon) => [salon.id, salon.name]));

  const total = emptyBuckets();
  const perSalon = [...bySalon.entries()].map(([salonId, b]) => {
    total.pendingMinor += b.pendingMinor;
    total.availableMinor += b.availableMinor;
    total.inPayoutMinor += b.inPayoutMinor;
    total.paidMinor += b.paidMinor;
    return {
      salonId,
      salonName: salonId ? (nameOf.get(salonId) ?? "Deleted branch") : "Deleted branch",
      ...withDues(b),
    };
  });

  return {
    ownerId,
    holdDays,
    minMinor,
    nextPayoutDate: nextPayoutDate(weekday, now),
    ...withDues(total),
    perSalon: perSalon.sort((a, b) => a.salonName.localeCompare(b.salonName)),
  };
};

/**
 * The payouts an owner sees for these salons: a salon's own payouts, plus the
 * business-wide ones (salonId null) of the businesses that own them.
 */
export const payoutScope = async (salonIds: string[]): Promise<Prisma.PayoutWhereInput> => {
  const owners = await prisma.salon.findMany({
    where: { id: { in: salonIds } },
    select: { ownerId: true },
    distinct: ["ownerId"],
  });
  return {
    OR: [
      { salonId: { in: salonIds } },
      { salonId: null, ownerId: { in: owners.map((owner) => owner.ownerId) } },
    ],
  };
};

/**
 * Payouts that are not test data. A business payout has no salon, so its
 * owner's account carries the isTest flag.
 */
export const realPayoutWhere = (includeTest: boolean): Prisma.PayoutWhereInput =>
  includeTest
    ? {}
    : {
        OR: [
          { salon: { isTest: false } },
          { salonId: null, owner: { user: { isTest: false } } },
        ],
      };
