/**
 * Checks for the money engine (owner Phase 2).
 *
 *   npm run verify:money
 *
 * Everything runs inside ONE transaction that is always rolled back (a
 * sentinel error at the end): an isTest owner with two salons (Mirpur,
 * Dhanmondi) and a customer are seeded, bookings are settled, journals
 * written, payouts raised and moved through the state machine, then all of it
 * disappears. Settings are read from the live registry; checks that depend on
 * a non-default value say so instead of failing. Finally, read-only on the
 * whole database: every journal sums to zero.
 *
 * Exits 1 on any FAIL. Nothing secret is printed.
 */
import "../config"; // loads .env
import { randomUUID } from "crypto";
import {
  AppointmentSource,
  AppointmentStatus,
  DepositStatus,
  LedgerAccount,
  PayoutStatus,
  Prisma,
  UserRole,
} from "@prisma/client";
import prisma from "../app/shared/prisma";
import { getSetting } from "../app/utils/settings";
import { systemAuditCtx } from "../app/utils/audit";
import { AppointmentDeposit } from "../app/modules/Appointment/appointment.deposit";
import { getOwnerBuckets } from "../app/modules/Settlement/settlement.buckets";
import {
  SettlementService,
  transitionPayout,
  writeJournal,
} from "../app/modules/Settlement/settlement.service";

const rows: Array<{ check: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = "") => rows.push({ check: name, ok, detail });
const skip = (name: string, why: string) => rows.push({ check: name, ok: true, detail: `skip: ${why}` });

class Rollback extends Error {}

const DAY = 24 * 60 * 60 * 1000;
const ctx = { ctx: systemAuditCtx("cli"), reason: "verify:money" };

/** The HTTP status of an ApiError thrown by `fn`, or null when it did not throw. */
const statusOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? 500;
  }
};

const run = async (tx: Prisma.TransactionClient) => {
  const [holdDays, minMinor, onDirect, approvals] = await Promise.all([
    getSetting("payouts.holdDays"),
    getSetting("payouts.minMinor"),
    getSetting("booking.commissionOnDirect"),
    getSetting("approvals.enabled"),
  ]);
  console.log(
    `settings: holdDays=${holdDays} minMinor=${minMinor} commissionOnDirect=${onDirect} approvals=${approvals}`,
  );

  // ------------------------------------------------------------ seed
  const tag = randomUUID().slice(0, 8);
  const ownerUser = await tx.user.create({
    data: {
      email: `verify-money-owner-${tag}@seed.example.com`,
      name: "Verify Money Owner",
      role: UserRole.SALON_OWNER,
      isTest: true,
    },
  });
  const owner = await tx.salonOwner.create({
    data: { userId: ownerUser.id, businessName: `Verify Money ${tag}` },
  });
  const customer = await tx.user.create({
    data: { email: `verify-money-customer-${tag}@seed.example.com`, name: "Verify Customer", isTest: true },
  });
  const salon = (name: string, area: string) =>
    tx.salon.create({
      data: {
        name,
        address: `${area} test road`,
        area,
        city: "Dhaka",
        phone: "01700000000",
        images: [],
        ownerId: owner.id,
        isTest: true,
      },
    });
  const mirpur = await salon(`Verify Mirpur ${tag}`, "Mirpur");
  const dhanmondi = await salon(`Verify Dhanmondi ${tag}`, "Dhanmondi");
  const service = await tx.service.create({
    data: { name: "Haircut", category: "HAIRCUT", priceMinor: 45000, duration: 30, salonId: mirpur.id, images: [] },
  });
  const counter = await tx.counter.create({ data: { salonId: mirpur.id, name: "Chair 1" } });

  const booking = (source: AppointmentSource, depositMinor: number) =>
    tx.appointment.create({
      data: {
        customerId: customer.id,
        salonId: mirpur.id,
        serviceId: service.id,
        counterId: counter.id,
        appointmentDate: new Date(),
        startTime: "10:00",
        status: AppointmentStatus.COMPLETED,
        totalMinor: 45000,
        depositMinor,
        // Applied at check-in; settlement only writes the ledger.
        depositStatus: depositMinor > 0 ? DepositStatus.APPLIED : DepositStatus.NONE,
        commissionBps: 1000,
        source,
      },
    });

  const salonPayable = (appointmentId: string) =>
    tx.ledgerEntry.findMany({
      where: { appointmentId, account: LedgerAccount.SALON_PAYABLE },
      select: { amountMinor: true },
      orderBy: { amountMinor: "asc" },
    });

  // ------------------------------------------------------------ commission
  const walkIn = await booking(AppointmentSource.SALON_DIRECT, 0);
  await AppointmentDeposit.settleCompletedTx(tx, walkIn.id);
  const walkInRevenue = await tx.ledgerEntry.count({
    where: { appointmentId: walkIn.id, account: LedgerAccount.PLATFORM_REVENUE },
  });
  if (onDirect) skip("walk-in completion writes no commission", "booking.commissionOnDirect is on");
  else check("walk-in completion writes no commission", walkInRevenue === 0, `${walkInRevenue} revenue row(s)`);

  const platform = await booking(AppointmentSource.PLATFORM, 3000);
  await AppointmentDeposit.settleCompletedTx(tx, platform.id);
  const payable = (await salonPayable(platform.id)).map((row) => row.amountMinor);
  check(
    "platform ৳450 / ৳30 deposit → SALON_PAYABLE +3000 / −4500",
    payable.length === 2 && payable[0] === -4500 && payable[1] === 3000,
    JSON.stringify(payable),
  );
  const journal = await tx.ledgerEntry.findMany({
    where: { appointmentId: platform.id },
    select: { journalId: true, ownerId: true },
  });
  check(
    "booking journal = appointment id, ownerId from the salon",
    journal.every((row) => row.journalId === platform.id && row.ownerId === owner.id),
  );

  const unbalancedRefused = await statusOf(() =>
    writeJournal(tx, {
      salonId: mirpur.id,
      kind: "verify.unbalanced",
      drafts: [{ account: LedgerAccount.SALON_PAYABLE, amountMinor: 100, description: "x" }],
    }),
  );
  check("writeJournal refuses an unbalanced set", unbalancedRefused === 500, `status ${unbalancedRefused}`);

  // ------------------------------------------------------------ buckets
  const buckets = await getOwnerBuckets(owner.id, { db: tx });
  if (holdDays > 0) {
    check(
      "today's entry is pending, nothing available",
      buckets.pendingMinor === -1500 && buckets.availableMinor === 0,
      `pending ${buckets.pendingMinor}, available ${buckets.availableMinor}`,
    );
    check("dues = −(pending + available)", buckets.duesMinor === 1500, `dues ${buckets.duesMinor}`);
  } else {
    skip("today's entry is pending", "payouts.holdDays is 0");
  }

  // Seeds past the hold: a balanced journal (salon payable vs gateway
  // clearing) backdated so it is available. Backdating is test-only.
  const old = new Date(Date.now() - (holdDays + 1) * DAY);
  const availableJournal = async (salonId: string, amountMinor: number) => {
    const journalId = await writeJournal(tx, {
      salonId,
      kind: "verify.seed",
      drafts: [
        { account: LedgerAccount.SALON_PAYABLE, amountMinor, description: "verify seed" },
        { account: LedgerAccount.GATEWAY_CLEARING, amountMinor: -amountMinor, description: "verify seed" },
      ],
    });
    await tx.ledgerEntry.updateMany({ where: { journalId: journalId! }, data: { createdAt: old } });
  };

  // ------------------------------------------------------------ minimum
  await availableJournal(mirpur.id, 30000);
  const preview = await SettlementService.previewPayoutBatch({ ownerId: owner.id, db: tx });
  if (minMinor > 30000) {
    const skipped = preview.skipped.find((row) => row.ownerId === owner.id);
    check(
      "৳300 available → skipped below minimum",
      preview.rows.length === 0 && skipped?.reason === "below minimum",
      skipped ? `${skipped.netMinor} skipped: ${skipped.reason}` : `${preview.rows.length} row(s) raised`,
    );
  } else {
    skip("৳300 available → skipped below minimum", `payouts.minMinor is ${minMinor}`);
  }

  // ------------------------------------------------------------ netting
  // Mirpur +৳800 in all (300 + 500), Dhanmondi −৳300: one business payout of ৳500.
  await availableJournal(mirpur.id, 50000);
  await availableJournal(dhanmondi.id, -30000);
  const batch = () => SettlementService.runPayoutBatch({ ownerId: owner.id, db: tx }, ctx);
  const first = await batch();
  const p1 = first.created[0];
  if (minMinor <= 50000) {
    check(
      "Mirpur +800 / Dhanmondi −300 → one payout of ৳500",
      first.created.length === 1 && p1?.netMinor === 50000 && p1.salonId === null,
      first.created.map((c) => `${c.netMinor} salon=${c.salonId ?? "business"}`).join(", ") || "none",
    );
  } else {
    skip("netting → one payout of ৳500", `payouts.minMinor is ${minMinor}`);
  }

  const total = await tx.ledgerEntry.aggregate({
    where: { ownerId: owner.id, account: LedgerAccount.SALON_PAYABLE },
    _sum: { amountMinor: true },
  });
  const after = await getOwnerBuckets(owner.id, { db: tx });
  const bucketSum = after.pendingMinor + after.availableMinor + after.inPayoutMinor + after.paidMinor;
  check(
    "buckets sum = Σ SALON_PAYABLE",
    bucketSum === (total._sum.amountMinor ?? 0),
    `${bucketSum} vs ${total._sum.amountMinor}`,
  );
  if (p1) check("payout's entries sit in inPayout", after.inPayoutMinor === 50000, `inPayout ${after.inPayoutMinor}`);

  // ------------------------------------------------------------ state machine
  const claimed = async (payoutId: string) => tx.ledgerEntry.count({ where: { payoutId } });

  if (p1) {
    const missingReason = await statusOf(() =>
      transitionPayout(p1.payoutId, PayoutStatus.CANCELLED, {}, ctx, tx),
    );
    check("CANCELLED without a reason → 400", missingReason === 400, `status ${missingReason}`);

    await transitionPayout(p1.payoutId, PayoutStatus.CANCELLED, { cancelledReason: "verify" }, ctx, tx);
    check("CANCELLED releases its entries", (await claimed(p1.payoutId)) === 0);
    const reopen = await statusOf(() =>
      transitionPayout(p1.payoutId, PayoutStatus.PAID, { method: "BKASH", reference: `V-${tag}-x` }, ctx, tx),
    );
    check("CANCELLED → PAID → 409", reopen === 409, `status ${reopen}`);

    const p2 = (await batch()).created[0];
    check("released money goes in the next run", p2?.netMinor === 50000, `net ${p2?.netMinor ?? "none"}`);
    if (p2) {
      await transitionPayout(p2.payoutId, PayoutStatus.PROCESSING, {}, ctx, tx);
      await transitionPayout(p2.payoutId, PayoutStatus.FAILED, { failureReason: "verify" }, ctx, tx);
      check("FAILED releases its entries", (await claimed(p2.payoutId)) === 0);
    }

    const p3 = (await batch()).created[0];
    if (p3) {
      const approved = await transitionPayout(p3.payoutId, PayoutStatus.APPROVED, {}, ctx, tx);
      check("APPROVED stamps approvedAt", approved.approvedAt !== null);
      await transitionPayout(
        p3.payoutId,
        PayoutStatus.PAID,
        { method: "BKASH", reference: `V-${tag}-3` },
        { ...ctx, fourEyesCleared: true },
        tx,
      );
      const paidToFailed = await statusOf(() =>
        transitionPayout(p3.payoutId, PayoutStatus.FAILED, { failureReason: "verify" }, ctx, tx),
      );
      check("PAID → FAILED → 409", paidToFailed === 409, `status ${paidToFailed}`);
      const paidBuckets = await getOwnerBuckets(owner.id, { db: tx });
      check("paid bucket holds the paid payout", paidBuckets.paidMinor === 50000, `paid ${paidBuckets.paidMinor}`);
    } else {
      check("third run raised a payout", false);
    }
  }

  // ------------------------------------------------------------ zero-sum
  const journals = await tx.ledgerEntry.groupBy({
    by: ["journalId"],
    where: { ownerId: owner.id },
    _sum: { amountMinor: true },
  });
  const bad = journals.filter((row) => (row._sum.amountMinor ?? 0) !== 0);
  check("every seeded journal sums to 0", bad.length === 0, `${bad.length} of ${journals.length} unbalanced`);

  throw new Rollback();
};

const main = async () => {
  try {
    await prisma.$transaction(run, { timeout: 180_000, maxWait: 15_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      check("scenario ran to the end", false, error instanceof Error ? error.message : String(error));
    }
  }

  // Read-only on the real ledger, outside the rolled-back transaction.
  const unbalanced = await SettlementService.findUnbalancedAppointments();
  check("live DB: every journal sums to 0", unbalanced.length === 0, `${unbalanced.length} unbalanced`);

  const width = Math.max(...rows.map((row) => row.check.length));
  for (const row of rows) {
    console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.check.padEnd(width)}  ${row.detail}`);
  }
  const failed = rows.filter((row) => !row.ok).length;
  console.log(`\nverify:money ${failed ? "FAILED" : "passed"}: ${rows.length - failed}/${rows.length} (rolled back)`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
};

void main();
