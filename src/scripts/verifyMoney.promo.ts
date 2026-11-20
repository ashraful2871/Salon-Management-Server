/**
 * verify:money section "Referral promo" (referral Phase 7.3).
 *
 * Every journal holding a PLATFORM_PROMO line sums to 0 and pairs it with a
 * SALON_PAYABLE "Referral discount paid by platform" line of the same absolute
 * amount on the same booking; no PLATFORM_PROMO line is without a booking id.
 *
 * `runPromo` settles one promo booking inside the caller's rolled-back
 * transaction, then proves the three queries see it as clean and catch a
 * planted bad line. `promoLedgerProblems` is the read-only form the caller
 * also runs on the whole database.
 */
import { randomUUID } from "crypto";
import { AppointmentSource, AppointmentStatus, LedgerAccount, Prisma, UserRole } from "@prisma/client";
import { AppointmentDeposit } from "../app/modules/Appointment/appointment.deposit";
import { PROMO_PLATFORM_DESCRIPTION, PROMO_SALON_DESCRIPTION } from "../app/modules/Settlement/settlement.service";

type Db = Pick<Prisma.TransactionClient, "$queryRaw">;
type Check = (name: string, ok: boolean, detail?: string) => void;

export type PromoProblems = { unbalanced: number; unmatched: number; noBooking: number };

export const promoLedgerProblems = async (db: Db): Promise<PromoProblems> => {
  const [row] = await db.$queryRaw<Array<{ unbalanced: bigint; unmatched: bigint; noBooking: bigint }>>`
    SELECT
      (SELECT COUNT(*) FROM (
         SELECT l."journalId"
         FROM ledger_entries l
         WHERE l."journalId" IN (SELECT "journalId" FROM ledger_entries WHERE account = 'PLATFORM_PROMO')
         GROUP BY l."journalId"
         HAVING SUM(l."amountMinor") <> 0
       ) u) AS unbalanced,
      (SELECT COUNT(*) FROM ledger_entries p
       WHERE p.account = 'PLATFORM_PROMO'
         AND NOT EXISTS (
           SELECT 1 FROM ledger_entries s
           WHERE s."journalId" = p."journalId"
             AND s.account = 'SALON_PAYABLE'
             AND s.description = ${PROMO_SALON_DESCRIPTION}
             AND s."amountMinor" = -p."amountMinor"
             AND s."appointmentId" IS NOT DISTINCT FROM p."appointmentId"
             AND s."homeBookingId" IS NOT DISTINCT FROM p."homeBookingId")) AS unmatched,
      (SELECT COUNT(*) FROM ledger_entries
       WHERE account = 'PLATFORM_PROMO' AND "appointmentId" IS NULL AND "homeBookingId" IS NULL) AS "noBooking"`;
  return { unbalanced: Number(row.unbalanced), unmatched: Number(row.unmatched), noBooking: Number(row.noBooking) };
};

const show = (p: PromoProblems) => `${p.unbalanced} unbalanced, ${p.unmatched} unmatched, ${p.noBooking} without a booking`;

export const runPromo = async (tx: Prisma.TransactionClient, check: Check) => {
  const before = await promoLedgerProblems(tx);

  const tag = randomUUID().slice(0, 8);
  const ownerUser = await tx.user.create({
    data: { email: `verify-money-promo-owner-${tag}@seed.example.com`, name: "Verify Promo Owner", role: UserRole.SALON_OWNER, isTest: true },
  });
  const owner = await tx.salonOwner.create({ data: { userId: ownerUser.id, businessName: `Verify Promo ${tag}` } });
  const customer = await tx.user.create({
    data: { email: `verify-money-promo-customer-${tag}@seed.example.com`, name: "Verify Promo Customer", isTest: true },
  });
  const salon = await tx.salon.create({
    data: { name: `Verify Promo ${tag}`, address: "Mirpur test road", area: "Mirpur", city: "Dhaka", phone: "01700000000", images: [], ownerId: owner.id, isTest: true },
  });
  const service = await tx.service.create({
    data: { name: "Haircut", category: "HAIRCUT", priceMinor: 200000, duration: 60, salonId: salon.id, images: [] },
  });
  const counter = await tx.counter.create({ data: { salonId: salon.id, name: "Chair 1" } });
  const appointment = await tx.appointment.create({
    data: {
      customerId: customer.id,
      salonId: salon.id,
      serviceId: service.id,
      counterId: counter.id,
      appointmentDate: new Date(),
      startTime: "10:00",
      endTime: "11:00",
      status: AppointmentStatus.COMPLETED,
      completedAt: new Date(),
      completedById: ownerUser.id,
      source: AppointmentSource.PLATFORM,
      totalMinor: 200000,
      depositMinor: 0,
      commissionBps: 1000,
      promoDiscountMinor: 10000,
      promoLabel: "Welcome reward (5%)",
    },
  });
  await AppointmentDeposit.settleCompletedTx(tx, appointment.id);

  const lines = await tx.ledgerEntry.findMany({ where: { appointmentId: appointment.id } });
  const promo = lines.filter((l) => l.account === LedgerAccount.PLATFORM_PROMO);
  const paid = lines.filter((l) => l.account === LedgerAccount.SALON_PAYABLE && l.description === PROMO_SALON_DESCRIPTION);
  check(
    "promo: settled booking writes PLATFORM_PROMO −৳100 and SALON_PAYABLE +৳100",
    promo.length === 1 && promo[0].amountMinor === -10000 && promo[0].description === PROMO_PLATFORM_DESCRIPTION && paid.length === 1 && paid[0].amountMinor === 10000 && paid[0].journalId === promo[0].journalId,
    `${promo.map((l) => l.amountMinor).join(",")} / ${paid.map((l) => l.amountMinor).join(",")}`,
  );
  check("promo: its journal sums to 0", lines.reduce((s, l) => s + l.amountMinor, 0) === 0, `${lines.length} line(s)`);
  const after = await promoLedgerProblems(tx);
  check("promo: the queries see the new journal as clean", JSON.stringify(after) === JSON.stringify(before), show(after));

  // A planted line with no partner and no booking: each query must catch it.
  await tx.$executeRawUnsafe("SAVEPOINT promo_probe");
  await tx.ledgerEntry.create({
    data: { journalId: randomUUID(), account: LedgerAccount.PLATFORM_PROMO, amountMinor: -500, description: PROMO_PLATFORM_DESCRIPTION, salonId: salon.id, ownerId: owner.id },
  });
  const planted = await promoLedgerProblems(tx);
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT promo_probe");
  check(
    "promo: a lone PLATFORM_PROMO line is caught by all three queries",
    planted.unbalanced === before.unbalanced + 1 && planted.unmatched === before.unmatched + 1 && planted.noBooking === before.noBooking + 1,
    show(planted),
  );
};

export const describePromoProblems = show;
