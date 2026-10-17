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
  BookingPause,
  IntentPurpose,
  IntentStatus,
  SalonStatus,
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
import { paymentSummary } from "../app/modules/Appointment/appointment.billing";
import { expectedForDay } from "../app/modules/Owner/owner.dailyClose";
import { dhakaDay } from "../app/modules/Analytics/analytics.days";
import { getOwnerBuckets } from "../app/modules/Settlement/settlement.buckets";
import { allocateDues, settleDuesPayment, waiveDues, watchOwner } from "../app/modules/Settlement/settlement.dues";
import { assertTakingOnlineBookings } from "../app/modules/Appointment/appointment.service";
import {
  balanceAt,
  buildInvoice,
  buildMonthly,
  computeMonthly,
  monthBounds,
  previousMonth,
} from "../app/modules/Owner/owner.statements";
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

  // ------------------------------------------------------------ destination
  // Payable money, but nowhere verified to send it: skipped, nothing claimed.
  const skippedFor = async () =>
    (await batch()).skipped.find((row) => row.ownerId === owner.id)?.reason ?? "raised";
  if (minMinor <= 50000) {
    const noAccount = await skippedFor();
    check("owner without verified account is skipped", noAccount === "no verified account", noAccount);

    const account = await tx.payoutAccount.create({
      data: {
        ownerId: owner.id,
        type: "BKASH",
        accountName: "Verify Owner",
        walletNumber: "01712345678",
        last4: "5678",
        status: "VERIFIED",
        verifiedAt: new Date(),
        cooldownUntil: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const cooling = await skippedFor();
    check("verified account in cooldown is skipped", cooling === "account cooldown", cooling);

    await tx.payoutAccount.update({ where: { id: account.id }, data: { cooldownUntil: null } });
    await tx.salonOwner.update({ where: { id: owner.id }, data: { payoutsFrozen: true } });
    const frozen = await skippedFor();
    check("frozen business is skipped", frozen === "frozen", frozen);
    await tx.salonOwner.update({ where: { id: owner.id }, data: { payoutsFrozen: false } });
  } else {
    skip("destination skips", `payouts.minMinor is ${minMinor}`);
  }

  const first = await batch();
  const p1 = first.created[0];
  if (p1) {
    const row = await tx.payout.findUniqueOrThrow({ where: { id: p1.payoutId } });
    const snap = row.destinationSnapshot as { type?: string; last4?: string } | null;
    check(
      "payout stores account id + destination snapshot",
      !!row.payoutAccountId && snap?.type === "BKASH" && snap.last4 === "5678",
      JSON.stringify(snap),
    );
  }
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

  // ------------------------------------------------------------ checkout v2 (Phase 14)
  // ৳450 bill, ৳30 deposit, ৳50 discount, ৳40 tip: commission is 10% of the
  // billable ৳400 = ৳40; the tip sits on the payment, never in the ledger.
  const discounted = await tx.appointment.update({
    where: { id: (await booking(AppointmentSource.PLATFORM, 3000)).id },
    data: { discountMinor: 5000, discountReason: "verify:money", tipMinor: 4000 },
  });
  await AppointmentDeposit.settleCompletedTx(tx, discounted.id);
  const discRevenue = await tx.ledgerEntry.findMany({
    where: { appointmentId: discounted.id },
    select: { account: true, amountMinor: true },
  });
  const commission = discRevenue
    .filter((r) => r.account === LedgerAccount.PLATFORM_REVENUE)
    .reduce((s, r) => s + r.amountMinor, 0);
  check("checkout v2: ৳450 − ৳50 discount + ৳40 tip → commission ৳40", commission === 4000, `commission ${commission}`);
  check(
    "checkout v2: discounted journal balanced",
    discRevenue.length > 0 && discRevenue.reduce((s, r) => s + r.amountMinor, 0) === 0,
    JSON.stringify(discRevenue.map((r) => r.amountMinor)),
  );
  const due = paymentSummary(discounted).amountDueMinor;
  await tx.payment.create({
    data: {
      appointmentId: discounted.id,
      amountMinor: due,
      tipMinor: 4000,
      paymentMethod: "CASH",
      status: "COMPLETED",
      paymentDate: new Date(),
    },
  });
  const paid = paymentSummary(await tx.appointment.findUniqueOrThrow({ where: { id: discounted.id }, include: { payment: true } }));
  check(
    "checkout v2: due = ৳370, then PAID with nothing left",
    due === 37000 && paid.amountDueMinor === 0 && paid.paymentState === "PAID" && paid.billableMinor === 40000,
    `due ${due} → ${paid.amountDueMinor} ${paid.paymentState}`,
  );

  // ------------------------------------------------------------ daily close (Phase 14)
  const today = dhakaDay();
  const expected = await expectedForDay(mirpur.id, today, tx);
  check("daily close: expected cash = bill + tip (৳410)", expected.cashMinor === 41000, JSON.stringify(expected));
  const closeData = {
    salonId: mirpur.id,
    date: new Date(`${today}T00:00:00Z`),
    expectedCashMinor: expected.cashMinor,
    countedCashMinor: 40000,
    cardMinor: 0,
    mobileMinor: 0,
    differenceMinor: 40000 - expected.cashMinor,
    closedById: ownerUser.id,
  };
  await tx.dailyClose.create({ data: closeData });
  await tx.$executeRawUnsafe("SAVEPOINT close_twice");
  let secondClose = "created";
  try {
    await tx.dailyClose.create({ data: closeData });
  } catch (err) {
    secondClose = (err as { code?: string }).code ?? "error";
  }
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT close_twice");
  check("daily close: second close for the same day refused (P2002 → 409)", secondClose === "P2002", secondClose);

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


// ------------------------------------------------------------ dues (Phase 6)
// Its own business and its own rolled-back transaction.
const runDues = async (tx: Prisma.TransactionClient) => {
  const tag = randomUUID().slice(0, 8);
  const user = await tx.user.create({
    data: { email: `verify-dues-owner-${tag}@seed.example.com`, name: "Verify Dues Owner", role: UserRole.SALON_OWNER, isTest: true },
  });
  const owner = await tx.salonOwner.create({ data: { userId: user.id, businessName: `Verify Dues ${tag}` } });
  const salon = (name: string, bookingPause: BookingPause = BookingPause.NONE) =>
    tx.salon.create({
      data: {
        name, address: "test road", area: "Mirpur", city: "Dhaka", phone: "01700000000", images: [],
        ownerId: owner.id, isTest: true, status: SalonStatus.ACTIVE, bookingPause,
      },
    });
  const a = await salon(`Verify Dues A ${tag}`);
  const b = await salon(`Verify Dues B ${tag}`);
  const c = await salon(`Verify Dues C ${tag}`, BookingPause.OWNER);
  const owe = (salonId: string, amountMinor: number) =>
    writeJournal(tx, {
      salonId, ownerId: owner.id, kind: "verify.commission",
      drafts: [
        { account: LedgerAccount.SALON_PAYABLE, amountMinor: -amountMinor, description: "Platform commission deducted" },
        { account: LedgerAccount.PLATFORM_REVENUE, amountMinor, description: "Platform commission deducted" },
      ],
    });
  await owe(a.id, 150000);
  await owe(b.id, 100000);

  const before = await getOwnerBuckets(owner.id, { db: tx });
  check("dues: owner at −৳2,500", before.duesMinor === 250000, `dues ${before.duesMinor}`);

  const alloc = allocateDues(
    [{ salonId: "a", balanceMinor: -15000 }, { salonId: "b", balanceMinor: -10000 }],
    20000,
  );
  check(
    "dues: allocation most negative first",
    alloc.length === 2 && alloc[0].salonId === "a" && alloc[0].amountMinor === 15000 && alloc[1].amountMinor === 5000,
    JSON.stringify(alloc),
  );

  // Pause: warn first, then pause 3 days later; OWNER pause untouched.
  const rules = { pauseEnabled: true, creditLimitMinor: 100000, maxAgeDays: 30 };
  const now = new Date();
  const warned = await watchOwner({ id: owner.id, duesSince: null, duesWarnedAt: null }, 250000, rules, now, { email: false, db: tx });
  const paused = await watchOwner(
    { id: owner.id, duesSince: now, duesWarnedAt: new Date(now.getTime() - 3 * DAY) },
    250000, rules, now, { email: false, db: tx },
  );
  const pauses = async () =>
    (await tx.salon.findMany({ where: { id: { in: [a.id, b.id, c.id] } }, select: { id: true, bookingPause: true } }))
      .map((s) => `${s.id === a.id ? "A" : s.id === b.id ? "B" : "C"}:${s.bookingPause}`).sort().join(",");
  const afterPause = await pauses();
  check(
    "dues: warn → pause (OWNER kept)",
    warned === "warned" && paused === "paused" && afterPause === "A:DUES,B:DUES,C:OWNER",
    `${warned}/${paused} ${afterPause}`,
  );
  let refused = 0;
  try {
    assertTakingOnlineBookings({ bookingPause: BookingPause.DUES });
  } catch (error) {
    refused = (error as { statusCode?: number; errorCode?: string }).errorCode === "SALON_PAUSED" ? 409 : -1;
  }
  check("dues: paused salon refuses online booking (409 SALON_PAUSED)", refused === 409, `status ${refused}`);

  // Pay with the same claim creditSettledIntent uses, twice (IPN + return).
  const intent = await tx.paymentIntent.create({
    data: {
      transactionId: `DUES-verify-${tag}`, userId: user.id, purpose: IntentPurpose.SALON_DUES,
      referenceId: owner.id, amountMinor: 250000, status: IntentStatus.PENDING, provider: "BKASH",
    },
  });
  const settle = async () => {
    const claim = await tx.paymentIntent.updateMany({
      where: { id: intent.id, status: { not: IntentStatus.SUCCESS } },
      data: { status: IntentStatus.SUCCESS, completedAt: new Date() },
    });
    if (claim.count) await settleDuesPayment(tx, intent, "bKash");
  };
  await settle();
  await settle();

  const lines = await tx.ledgerEntry.findMany({ where: { journalId: intent.id } });
  const sum = lines.reduce((t, l) => t + l.amountMinor, 0);
  check("dues: journal balanced, one per replay", lines.length === 4 && sum === 0, `${lines.length} rows, Σ ${sum}`);
  const toSalon = (id: string) =>
    lines.filter((l) => l.salonId === id && l.account === LedgerAccount.SALON_PAYABLE).reduce((t, l) => t + l.amountMinor, 0);
  check(
    "dues: allocated across two salons",
    toSalon(a.id) === 150000 && toSalon(b.id) === 100000 && lines.every((l) => l.account !== LedgerAccount.CUSTOMER_WALLET),
    `A ${toSalon(a.id)}, B ${toSalon(b.id)}`,
  );
  const after = await getOwnerBuckets(owner.id, { db: tx });
  check("dues: buckets 0 after paying", after.duesMinor === 0, `dues ${after.duesMinor}`);

  const resumed = await watchOwner({ id: owner.id, duesSince: now, duesWarnedAt: now }, after.duesMinor, rules, now, { email: false, db: tx });
  const afterResume = await pauses();
  check("dues: resume clears DUES only", resumed === "resumed" && afterResume === "A:NONE,B:NONE,C:OWNER", `${resumed} ${afterResume}`);

  // Waiver: SALON_PAYABLE + / PLATFORM_REVENUE −, balanced.
  await owe(a.id, 5000);
  const waived = await waiveDues(tx, { ownerId: owner.id, amountMinor: 5000, reason: "verify" });
  const w = await tx.ledgerEntry.aggregate({ where: { journalId: waived.journalId! }, _sum: { amountMinor: true } });
  const final = await getOwnerBuckets(owner.id, { db: tx });
  check("dues: waiver balanced and clears dues", w._sum.amountMinor === 0 && final.duesMinor === 0 && waived.salonId === a.id, `Σ ${w._sum.amountMinor}, dues ${final.duesMinor}`);

  throw new Rollback();
};
// ------------------------------------------------------------ statements (Phase 7)
// Its own business, ledger rows back-dated into the last two Dhaka months,
// and its own rolled-back transaction.

/** The Dhaka month containing `at`, "YYYY-MM". */
const dhakaMonth = (at: Date) => new Date(at.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 7);

const runStatements = async (tx: Prisma.TransactionClient) => {
  const tag = randomUUID().slice(0, 8);
  const user = await tx.user.create({
    data: { email: `verify-stmt-${tag}@seed.example.com`, name: "Verify Statements", role: UserRole.SALON_OWNER, isTest: true },
  });
  const owner = await tx.salonOwner.create({ data: { userId: user.id, businessName: `Verify Statements ${tag}` } });
  const salon = await tx.salon.create({
    data: { name: `Verify Stmt ${tag}`, address: "Test road", area: "Mirpur", city: "Dhaka", phone: "01700000000", images: [], ownerId: owner.id, isTest: true },
  });

  const month = previousMonth();
  const { periodStart, periodEnd } = monthBounds(month);
  const before = previousMonth(periodStart); // the month before `month`
  const earlier = monthBounds(before).periodStart;
  const at = (base: Date, days: number) => new Date(base.getTime() + days * DAY);

  // A balanced journal of [account, amount, description] legs at a back-dated instant.
  const journal = async (createdAt: Date, legs: Array<[LedgerAccount, number, string]>) => {
    const journalId = randomUUID();
    await tx.ledgerEntry.createMany({
      data: legs.map(([account, amountMinor, description]) => ({
        id: randomUUID(), journalId, salonId: salon.id, ownerId: owner.id, account, amountMinor, description, createdAt,
      })),
    });
    return journalId;
  };
  const W = LedgerAccount.CUSTOMER_WALLET;
  const S = LedgerAccount.SALON_PAYABLE;
  const R = LedgerAccount.PLATFORM_REVENUE;

  // The month before: ৳200 deposit − ৳20 commission, paid out during `month`.
  const old = await journal(at(earlier, 3), [
    [W, -20000, "Deposit applied to the bill"],
    [S, 20000, "Deposit owed to salon"],
    [S, -2000, "Platform commission deducted"],
    [R, 2000, "Platform commission"],
  ]);
  const paidPayout = await tx.payout.create({
    data: {
      ownerId: owner.id, salonId: salon.id, periodStart: earlier, periodEnd: periodStart,
      grossMinor: 20000, commissionMinor: 2000, netMinor: 18000,
      status: PayoutStatus.PAID, method: "BKASH", reference: `VS-${tag}-1`, paidAt: at(periodStart, 10),
    },
  });
  await tx.ledgerEntry.updateMany({ where: { journalId: old, account: S }, data: { payoutId: paidPayout.id } });

  // `month`: ৳500 deposit − ৳50 commission, then a ৳10 goodwill credit.
  await journal(at(periodStart, 2), [
    [W, -50000, "Deposit applied to the bill"],
    [S, 50000, "Deposit owed to salon"],
    [S, -5000, "Platform commission deducted"],
    [R, 5000, "Platform commission"],
  ]);
  await journal(at(periodStart, 5), [
    [W, 1000, "Goodwill credit - salon cancelled"],
    [S, -1000, "Goodwill credit funded by salon"],
  ]);

  const built = await buildMonthly(owner.id, month, tx);
  const t = built.statement.totals as Record<string, number>;
  const ledgerClosing = await balanceAt(tx, owner.id, periodEnd);
  check(
    "statements: monthly closing = ledger",
    built.created && t.closingMinor === 44000 && t.closingMinor === ledgerClosing && t.openingMinor === 18000,
    `opening ${t.openingMinor}, closing ${t.closingMinor}, ledger ${ledgerClosing}`,
  );
  check(
    "statements: movements add up",
    t.depositsAppliedMinor === 50000 && t.commissionMinor === -5000 && t.goodwillMinor === -1000 && t.payoutsMinor === -18000,
    `deposits ${t.depositsAppliedMinor}, commission ${t.commissionMinor}, goodwill ${t.goodwillMinor}, payouts ${t.payoutsMinor}`,
  );
  const rebuilt = await computeMonthly(owner.id, month, tx);
  const again = await buildMonthly(owner.id, month, tx);
  check(
    "statements: rebuild gives the same ledgerHash",
    rebuilt.ledgerHash === built.statement.ledgerHash && !again.created && again.statement.id === built.statement.id,
    built.statement.ledgerHash.slice(0, 12),
  );
  const refused = await statusOf(() => buildMonthly(owner.id, dhakaMonth(new Date()), tx));
  check("statements: refuses a month that has not ended", refused === 400, `status ${refused}`);

  // Invoices: the older month is numbered after `month`, from one sequence.
  const i1 = (await buildInvoice(owner.id, month, tx))?.statement;
  const i2 = (await buildInvoice(owner.id, before, tx))?.statement;
  const seq = (num?: string | null) => Number(num?.slice(-6) ?? NaN);
  check(
    "statements: invoice numbers increase",
    !!i1 && !!i2 && /^SK-\d{4}-\d{6}$/.test(i1.number ?? "") && seq(i2.number) > seq(i1.number),
    `${i1?.number} → ${i2?.number}`,
  );
  const invoiceTotal = (i1?.totals as Record<string, number> | undefined)?.totalMinor;
  check("statements: invoice total = commission", invoiceTotal === 5000, `total ${invoiceTotal}`);

  // Immutability trigger; a savepoint keeps the transaction usable.
  await tx.$executeRawUnsafe("SAVEPOINT stmt_immutable");
  let blocked = false;
  try {
    await tx.ownerStatement.update({ where: { id: built.statement.id }, data: { ledgerHash: "x" } });
  } catch {
    blocked = true;
  }
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT stmt_immutable");
  check("statements: rows refuse UPDATE", blocked);

  // PAID writes the payout statement in the same transaction.
  const nowJournal = await journal(new Date(), [
    [W, -30000, "Deposit applied to the bill"],
    [S, 30000, "Deposit owed to salon"],
  ]);
  const pending = await tx.payout.create({
    data: { ownerId: owner.id, salonId: salon.id, periodStart: at(new Date(), -1), periodEnd: new Date(), grossMinor: 30000, commissionMinor: 0, netMinor: 30000 },
  });
  await tx.ledgerEntry.updateMany({ where: { journalId: nowJournal, account: S }, data: { payoutId: pending.id } });
  await transitionPayout(pending.id, PayoutStatus.APPROVED, {}, ctx, tx);
  await transitionPayout(pending.id, PayoutStatus.PAID, { method: "BKASH", reference: `VS-${tag}-2` }, { ...ctx, fourEyesCleared: true }, tx);
  const ps = await tx.ownerStatement.findUnique({ where: { payoutId: pending.id } });
  const psNet = (ps?.totals as Record<string, number> | undefined)?.netMinor;
  check("statements: PAID writes the payout statement", ps?.kind === "PAYOUT" && psNet === 30000, `net ${psNet ?? "none"}`);

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

  try {
    await prisma.$transaction(runDues, { timeout: 120_000, maxWait: 15_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      check("dues scenario ran to the end", false, error instanceof Error ? error.message : String(error));
    }
  }

  try {
    await prisma.$transaction(runStatements, { timeout: 120_000, maxWait: 15_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      check("statements scenario ran to the end", false, error instanceof Error ? error.message : String(error));
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
