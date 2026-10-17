/**
 * Test data for full in-app payment and the payout it feeds (owner Phase 15),
 * for ONE branch. Dry run by default; nothing is written without --apply.
 *
 *   npm run seed:prepaid -- --salon-name "Modern Men's Salon"        # dry run
 *   npm run seed:prepaid -- --salon <salonId> --apply                 # write
 *   npm run seed:prepaid -- --salon <salonId> --remove [--apply]      # take it out
 *
 * One test customer (prepaid-test@seed.example.com) gets a wallet credit (an
 * ADJUSTMENT marked "[test] seed:prepaid") and books everything "pay in full",
 * through the real hold + settlement functions (notes "[test] seed:prepaid"):
 *   days −10, −9, −8  ৳1,500 / ৳1,200 / ৳900 completed    → past the hold: in the
 *                                                          next payout preview
 *   day −9            ৳800 no-show                         → whole hold forfeited
 *                                                          (deposit 70/30 + prepaid
 *                                                          less commission)
 *   today             ৳1,000 completed                     → "Clearing" (inside the hold)
 *   today             ৳700 CHECKED_IN, still held          → check it out yourself:
 *                                                          ৳0 due, "Paid in app"
 * Ledger and wallet rows of the past bookings are back-dated to their day, so
 * the hold treats them as old. The dry run prints the owner's payout preview
 * now and the projected change.
 *
 * --remove deletes the marked bookings, their ledger rows, and the test
 * customer's wallet; it refuses while any of those ledger rows is in a payout
 * (cancel that payout first - CANCELLED releases its entries).
 */
import "../config"; // loads .env
import { AppointmentSource, AppointmentStatus, DepositStatus, WalletTxType } from "@prisma/client";
import prisma from "../app/shared/prisma";
import { formatBDT } from "../app/utils/money";
import { addDays, dayStart, dhakaDay } from "../app/modules/Analytics/analytics.days";
import { AppointmentDeposit } from "../app/modules/Appointment/appointment.deposit";
import { WalletService } from "../app/modules/Wallet/wallet.service";
import { SettlementService } from "../app/modules/Settlement/settlement.service";

const MARK = "[test] seed:prepaid";
const CUSTOMER_EMAIL = "prepaid-test@seed.example.com";
const HOUR = 60 * 60 * 1000;
const TX = { timeout: 30000, maxWait: 10000 };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = flag("--apply");
const remove = flag("--remove");

type Plan = {
  dayOffset: number;
  startTime: string;
  totalMinor: number;
  outcome: "COMPLETED" | "NO_SHOW" | "CHECKED_IN";
};

const PLANS: Plan[] = [
  { dayOffset: -10, startTime: "11:00", totalMinor: 150000, outcome: "COMPLETED" },
  { dayOffset: -9, startTime: "12:00", totalMinor: 120000, outcome: "COMPLETED" },
  { dayOffset: -9, startTime: "15:00", totalMinor: 80000, outcome: "NO_SHOW" },
  { dayOffset: -8, startTime: "16:00", totalMinor: 90000, outcome: "COMPLETED" },
  { dayOffset: 0, startTime: "10:00", totalMinor: 100000, outcome: "COMPLETED" },
  { dayOffset: 0, startTime: "18:00", totalMinor: 70000, outcome: "CHECKED_IN" },
];

const resolveSalon = async () => {
  const id = value("--salon");
  const name = value("--salon-name");
  if (!id && !name) throw new Error('Pass --salon <id> or --salon-name "<name>"');
  const salons = await prisma.salon.findMany({
    where: id ? { id, isDeleted: false } : { name: { equals: name, mode: "insensitive" }, isDeleted: false },
    include: { owner: { select: { id: true, userId: true, user: { select: { email: true } } } } },
    take: 20,
  });
  if (salons.length === 0) throw new Error("No branch found");
  if (salons.length > 1) {
    console.log(`${salons.length} branches match - rerun with --salon <id>:`);
    for (const s of salons) console.log(`  ${s.id}  ${s.name}  (owner ${s.owner.user.email})`);
    process.exit(1);
  }
  return salons[0];
};

const printPreview = async (ownerId: string, label: string) => {
  const preview = await SettlementService.previewPayoutBatch({ ownerId });
  const row = preview.rows[0] ?? preview.skipped[0];
  const reason = preview.skipped[0]?.reason;
  console.log(
    `${label}: ${row ? `net ${formatBDT(row.netMinor)}${reason ? ` (skipped: ${reason})` : " - would be paid"}` : "nothing available"} · hold ${preview.holdDays} d, minimum ${formatBDT(preview.minMinor)}`,
  );
};

const run = async () => {
  const salon = await resolveSalon();
  const today = dhakaDay();
  console.log(`branch: ${salon.name} (${salon.id}), owner ${salon.owner.user.email}; today ${today} (Dhaka)`);

  const existing = await prisma.appointment.findMany({
    where: { salonId: salon.id, notes: MARK },
    select: { id: true },
  });
  const customer = await prisma.user.findUnique({ where: { email: CUSTOMER_EMAIL }, select: { id: true } });

  if (remove) {
    const ids = existing.map((a) => a.id);
    const inPayout = await prisma.ledgerEntry.count({ where: { appointmentId: { in: ids }, payoutId: { not: null } } });
    const wallet = customer ? await prisma.wallet.findUnique({ where: { userId: customer.id }, select: { id: true } }) : null;
    console.log(`remove: ${ids.length} test booking(s), their ledger rows, and the test customer's wallet${wallet ? "" : " (none)"}`);
    if (inPayout > 0) {
      throw new Error(`${inPayout} of their ledger rows are in a payout. Cancel that payout first (CANCELLED releases its entries).`);
    }
    if (!apply) return console.log("dry run - add --apply to delete");
    await prisma.$transaction([
      prisma.ledgerEntry.deleteMany({ where: { appointmentId: { in: ids } } }),
      prisma.appointment.deleteMany({ where: { id: { in: ids } } }),
      ...(wallet
        ? [
            prisma.walletTransaction.deleteMany({ where: { walletId: wallet.id } }),
            prisma.wallet.delete({ where: { id: wallet.id } }),
          ]
        : []),
    ]);
    await printPreview(salon.ownerId, "payout preview after removal");
    return console.log("removed");
  }

  if (existing.length > 0) {
    throw new Error(`Already seeded (${existing.length} test bookings). Run with --remove --apply first.`);
  }

  const [service, counter] = await Promise.all([
    prisma.service.findFirst({ where: { salonId: salon.id, isDeleted: false }, select: { id: true, name: true } }),
    prisma.counter.findFirst({ where: { salonId: salon.id, isDeleted: false }, select: { id: true, name: true } }),
  ]);
  if (!service || !counter) throw new Error("The branch needs at least one service and one counter");

  const bps = await SettlementService.currentCommissionBps();
  const split = (totalMinor: number) => {
    const depositMinor = AppointmentDeposit.resolveDepositMinor(salon, totalMinor);
    return { depositMinor, prepaidMinor: totalMinor - depositMinor };
  };
  const salonGets = (plan: Plan) => {
    const { depositMinor, prepaidMinor } = split(plan.totalMinor);
    if (plan.outcome === "NO_SHOW") {
      const share = Math.round((depositMinor * Math.min(Math.max(salon.noShowSalonSharePct, 0), 100)) / 100);
      return share + prepaidMinor - SettlementService.resolveCommissionMinor(prepaidMinor, bps);
    }
    return plan.totalMinor - SettlementService.resolveCommissionMinor(plan.totalMinor, bps);
  };
  const available = PLANS.filter((p) => p.dayOffset < 0);
  const creditMinor = PLANS.reduce((s, p) => s + p.totalMinor, 0);

  console.log(`service "${service.name}", counter "${counter.name}", commission ${bps / 100}%`);
  for (const p of PLANS) {
    const { depositMinor, prepaidMinor } = split(p.totalMinor);
    console.log(
      `  ${addDays(today, p.dayOffset)} ${p.startTime}  ${formatBDT(p.totalMinor)} (deposit ${formatBDT(depositMinor)} + prepaid ${formatBDT(prepaidMinor)})  ${p.outcome}${p.outcome === "CHECKED_IN" ? "" : `  → salon ${formatBDT(salonGets(p))}`}`,
    );
  }
  console.log(`customer wallet credit: ${formatBDT(creditMinor)} (ADJUSTMENT, "${MARK}")`);
  console.log(`projected: +${formatBDT(available.reduce((s, p) => s + salonGets(p), 0))} past the hold, +${formatBDT(salonGets(PLANS[4]))} clearing`);
  await printPreview(salon.ownerId, "payout preview now");
  if (!salon.acceptsPrepay) console.log("note: this branch has acceptsPrepay off - the seed does not need it, the booking page does.");
  if (!apply) return console.log("dry run - add --apply to write");

  const testCustomer = await prisma.user.upsert({
    where: { email: CUSTOMER_EMAIL },
    update: {},
    create: { email: CUSTOMER_EMAIL, name: "Prepaid Test Customer", isTest: true },
  });
  await WalletService.mutate({
    userId: testCustomer.id,
    type: WalletTxType.ADJUSTMENT,
    amount: creditMinor,
    description: `${MARK} - wallet credit for test bookings`,
    idempotencyKey: `seed-prepaid-credit:${salon.id}:${Date.now()}`,
    metadata: { seed: "seed:prepaid", salonId: salon.id },
  });

  for (const plan of PLANS) {
    const day = addDays(today, plan.dayOffset);
    const [h, m] = plan.startTime.split(":").map(Number);
    // Dhaka wall clock of that day; today's bookings are stamped now.
    const at = plan.dayOffset < 0 ? new Date(dayStart(day).getTime() + (h + 1) * HOUR + m * 60000) : new Date();
    const bookedAt = new Date(at.getTime() - 48 * HOUR);
    const { depositMinor, prepaidMinor } = split(plan.totalMinor);

    await prisma.$transaction(async (tx) => {
      const a = await tx.appointment.create({
        data: {
          customerId: testCustomer.id,
          salonId: salon.id,
          serviceId: service.id,
          counterId: counter.id,
          appointmentDate: new Date(`${day}T00:00:00Z`),
          startTime: plan.startTime,
          status: AppointmentStatus.CONFIRMED,
          totalMinor: plan.totalMinor,
          depositMinor,
          prepaidMinor,
          depositStatus: DepositStatus.HELD,
          commissionBps: bps,
          source: AppointmentSource.PLATFORM,
          notes: MARK,
          ...(plan.dayOffset < 0 && { createdAt: bookedAt }),
        },
      });
      await WalletService.holdDeposit(testCustomer.id, plan.totalMinor, a.id, tx, { depositMinor, prepaidMinor });

      if (plan.outcome === "CHECKED_IN") {
        await tx.appointment.update({
          where: { id: a.id },
          data: { status: AppointmentStatus.CHECKED_IN, checkedInAt: at, checkedInById: salon.owner.userId },
        });
        return;
      }

      if (plan.outcome === "COMPLETED") {
        await tx.appointment.update({
          where: { id: a.id },
          data: {
            status: AppointmentStatus.COMPLETED,
            checkedInAt: at,
            checkedInById: salon.owner.userId,
            completedAt: at,
            completedById: salon.owner.userId,
          },
        });
        await AppointmentDeposit.settleCompletedTx(tx, a.id);
      } else {
        await tx.appointment.update({ where: { id: a.id }, data: { status: AppointmentStatus.NO_SHOW } });
        await AppointmentDeposit.settleForfeitedTx(tx, a.id);
        await tx.appointment.update({ where: { id: a.id }, data: { noShowMarkedAt: at } });
      }

      // Past days: the money moved on that day, so the hold treats it as old.
      if (plan.dayOffset < 0) {
        await tx.ledgerEntry.updateMany({ where: { appointmentId: a.id }, data: { createdAt: at } });
        await tx.walletTransaction.updateMany({
          where: { referenceType: "APPOINTMENT", referenceId: a.id },
          data: { createdAt: at },
        });
      }
    }, TX);
  }

  const unbalanced = await SettlementService.findUnbalancedAppointments();
  console.log(`seeded ${PLANS.length} bookings; live journals unbalanced: ${unbalanced.length}`);
  await printPreview(salon.ownerId, "payout preview after seeding");
};

run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
