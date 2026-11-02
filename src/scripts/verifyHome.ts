/**
 * Checks for Home Service: money (Phase 8), then access, gender, window and
 * races (Phase 16, `verifyHome.access.ts`).
 *
 *   npm run verify:home            # on the test branch from .env.homebranch
 *   npm run verify:home -- --env-db   # rolled-back part only, reports INCOMPLETE
 *
 * The access matrix and the races need committed rows, so they run only on the
 * test branch: on any other database they are skipped and the run exits 2,
 * never green. The rest runs inside ONE transaction that is always rolled back: an isTest
 * owner, salon, female expert, Ladies offering and a customer with a funded
 * wallet are seeded, home visits are booked (advance held), ended through
 * `endVisitTx` — the same path the routes use — and settled. Settings are
 * never edited: the fees-on cases write their policy into the booking's
 * snapshot, which is all the decision reads. Finally, read-only on the whole
 * database: every home journal sums to zero.
 *
 * Exits 1 on any FAIL.
 */
import { onHomeBranch } from "./homeBranchEnv"; // first: picks the database
import "../config";
import { randomUUID } from "crypto";
import {
  AdvanceStatus,
  BalanceMethod,
  ExpertVerification,
  Gender,
  HomeAudience,
  HomeBookingStatus,
  HomeCategory,
  LedgerAccount,
  Prisma,
  UserRole,
  WalletTxType,
} from "@prisma/client";
import prisma from "../app/shared/prisma";
import { getSetting } from "../app/utils/settings";
import { WalletService } from "../app/modules/Wallet/wallet.service";
import { currentPolicy, HomePolicy, policySnapshotOf } from "../app/modules/HomeService/home.policy";
import { EndEvent, endVisitTx, reverseFeeTx } from "../app/modules/HomeService/home.cancel";
import { settleHomeCompletedTx } from "../app/modules/HomeService/home.lifecycle";
import { addDays, dayStart, dhakaDay } from "../app/modules/Analytics/analytics.days";
import { getHomeAdvances, getHomeDailyMoney, getHomeOutcomes } from "../app/modules/Settlement/settlement.earnings";
import { checkCoverage, checkWindow, runLive } from "./verifyHome.access";

const rows: Array<{ check: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = "") => rows.push({ check: name, ok, detail });

class Rollback extends Error {}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const ADVANCE = 65000;

type Expect = { fee: number; refund: number; salon: number; platform: number; credit: number };

/** The state each end starts from, as the routes allow it. */
const FROM: Record<EndEvent["kind"], HomeBookingStatus> = {
  CUSTOMER_CANCEL: HomeBookingStatus.CONFIRMED,
  CUSTOMER_NO_SHOW: HomeBookingStatus.ARRIVED,
  MISMATCH_ABORT: HomeBookingStatus.ARRIVED,
  SALON_CANCEL: HomeBookingStatus.CONFIRMED,
  EXPERT_NO_SHOW: HomeBookingStatus.CONFIRMED,
  ADMIN_CANCEL: HomeBookingStatus.CONFIRMED,
  SYSTEM_CANCEL: HomeBookingStatus.CONFIRMED,
  SAFETY_ABORT: HomeBookingStatus.ARRIVED,
};

const ALL_EVENTS = (now: Date): Array<[string, EndEvent]> => [
  ["customer cancel", { kind: "CUSTOMER_CANCEL", now }],
  ["customer no-show", { kind: "CUSTOMER_NO_SHOW" }],
  ["mismatch abort", { kind: "MISMATCH_ABORT" }],
  ["salon cancel", { kind: "SALON_CANCEL" }],
  ["expert no-show", { kind: "EXPERT_NO_SHOW" }],
  ["admin cancel (salon at fault)", { kind: "ADMIN_CANCEL", salonAtFault: true }],
  ["admin cancel (not at fault)", { kind: "ADMIN_CANCEL", salonAtFault: false }],
  ["system cancel", { kind: "SYSTEM_CANCEL" }],
  ["safety abort", { kind: "SAFETY_ABORT" }],
];

const run = async (tx: Prisma.TransactionClient) => {
  const live = policySnapshotOf(await currentPolicy());
  const threshold = await getSetting("homeService.noShowBlockThreshold");
  console.log(
    `settings: policy=${live.policy} late=${live.lateCancelPercent} noShow=${live.noShowPercent} credit=${live.salonCancelCreditMinor} share=${live.feeSalonSharePercent} noShowBlockThreshold=${threshold}`,
  );
  const atLaunch =
    live.policy === "FREE" && live.lateCancelPercent === 0 && live.noShowPercent === 0 && live.salonCancelCreditMinor === 0;
  check("settings in force are the launch defaults (FREE, fees 0)", atLaunch, atLaunch ? "" : "launch cases still use a launch snapshot");

  // ------------------------------------------------------------ seed
  const tag = randomUUID().slice(0, 8);
  const ownerUser = await tx.user.create({
    data: { email: `verify-home-owner-${tag}@seed.example.com`, name: "Verify Home Owner", role: UserRole.SALON_OWNER, isTest: true },
  });
  const owner = await tx.salonOwner.create({ data: { userId: ownerUser.id, businessName: `Verify Home ${tag}` } });
  const salon = await tx.salon.create({
    data: {
      name: `Verify Home ${tag}`,
      address: "Mirpur test road",
      area: "Mirpur",
      city: "Dhaka",
      phone: "01700000000",
      images: [],
      ownerId: owner.id,
      isTest: true,
    },
  });
  const expertUser = await tx.user.create({
    data: { email: `verify-home-expert-${tag}@seed.example.com`, name: "Verify Expert", role: UserRole.STAFF, gender: Gender.FEMALE, isTest: true },
  });
  const staff = await tx.staff.create({ data: { userId: expertUser.id, salonId: salon.id } });
  const expert = await tx.homeExpert.create({
    data: {
      staffId: staff.id,
      salonId: salon.id,
      gender: Gender.FEMALE,
      audience: HomeAudience.LADIES,
      verification: ExpertVerification.VERIFIED,
      languages: [],
    },
  });
  const offering = await tx.homeServiceOffering.create({
    data: { salonId: salon.id, audience: HomeAudience.LADIES, category: HomeCategory.FACIAL, name: "Facial", durationMin: 60, priceMinor: 130000, images: [] },
  });
  const customer = await tx.user.create({
    data: {
      email: `verify-home-customer-${tag}@seed.example.com`,
      name: "Verify Home Customer",
      phone: "01711111111",
      emailVerified: true,
      isTest: true,
    },
  });
  const FUND = 2_000_000;
  await WalletService.mutate(
    { userId: customer.id, type: WalletTxType.ADJUSTMENT, amount: FUND, description: "verify:home funding", idempotencyKey: `verify-home-fund:${tag}` },
    tx,
  );

  const wallet = () => tx.wallet.findUniqueOrThrow({ where: { userId: customer.id }, select: { balance: true, heldBalance: true } });
  const payable = async () =>
    (
      await tx.ledgerEntry.aggregate({
        where: { salonId: salon.id, account: LedgerAccount.SALON_PAYABLE },
        _sum: { amountMinor: true },
      })
    )._sum.amountMinor ?? 0;
  const ledgerOf = (homeBookingId: string) =>
    tx.ledgerEntry.findMany({ where: { homeBookingId }, select: { account: true, amountMinor: true, journalId: true } });
  const sumOf = (lines: Array<{ account: LedgerAccount; amountMinor: number }>, account?: LedgerAccount) =>
    lines.filter((l) => !account || l.account === account).reduce((s, l) => s + l.amountMinor, 0);

  let slot = 0;
  /** A paid visit: advance held, in `status`, starting `startsIn` from now. */
  const book = async (o: {
    status: HomeBookingStatus;
    snapshot: HomePolicy;
    startsIn?: number;
    confirmedAgo?: number;
    advanceMinor?: number;
    balanceInApp?: boolean;
  }) => {
    const advanceMinor = o.advanceMinor ?? ADVANCE;
    const startAt = new Date(Date.now() + (o.startsIn ?? 24 * HOUR) + slot++ * 2 * HOUR);
    const endAt = new Date(startAt.getTime() + HOUR);
    const b = await tx.homeBooking.create({
      data: {
        code: `HS-V${tag.slice(0, 4).toUpperCase()}${slot}`,
        customerId: customer.id,
        salonId: salon.id,
        expertId: expert.id,
        audience: HomeAudience.LADIES,
        expertAudience: HomeAudience.LADIES,
        status: o.status,
        startAt,
        endAt,
        blockFrom: startAt,
        blockTo: endAt,
        serviceDate: new Date(`${startAt.toISOString().slice(0, 10)}T00:00:00Z`),
        addressLine: "House 1, Road 1",
        latitude: 23.8,
        longitude: 90.36,
        distanceKm: 1,
        recipientName: "Verify",
        contactPhone: "01711111111",
        subtotalMinor: advanceMinor * 2,
        travelFeeMinor: 0,
        totalMinor: advanceMinor * 2,
        advancePercent: 50,
        advanceMinor,
        balanceMinor: advanceMinor,
        commissionBps: 0,
        policySnapshot: o.snapshot as unknown as Prisma.InputJsonValue,
        disclaimerText: "verify",
        confirmedAt: new Date(Date.now() - (o.confirmedAgo ?? 60 * MIN)),
        arrivedAt: o.status === HomeBookingStatus.ARRIVED ? new Date(Date.now() - 30 * MIN) : null,
        isTest: true,
        items: { create: { offeringId: offering.id, nameSnapshot: "Facial", priceMinor: advanceMinor * 2, durationMin: 60 } },
      },
      select: { id: true },
    });
    await WalletService.holdHomeAdvance(customer.id, advanceMinor, b.id, tx);
    if (o.balanceInApp) {
      await WalletService.holdHomeBalance(customer.id, advanceMinor, b.id, tx);
      await tx.homeBooking.update({ where: { id: b.id }, data: { balanceMethod: BalanceMethod.WALLET } });
    }
    await tx.homeBooking.update({ where: { id: b.id }, data: { advanceStatus: AdvanceStatus.HELD } });
    return b.id;
  };

  /** Book, end, and compare the money with `expect`. */
  const runCase = async (
    label: string,
    event: EndEvent,
    snapshot: HomePolicy,
    expect: Expect,
    opts: { status?: HomeBookingStatus; startsIn?: number; confirmedAgo?: number; advanceMinor?: number; balanceInApp?: boolean } = {},
  ) => {
    const advanceMinor = opts.advanceMinor ?? ADVANCE;
    const w0 = await wallet();
    const p0 = await payable();
    const id = await book({ ...opts, status: opts.status ?? FROM[event.kind], snapshot });
    const r = await endVisitTx(tx, { id, event, from: [opts.status ?? FROM[event.kind]], actorId: null, actorRole: "SYSTEM", reason: "verify:home" });
    const o = r.outcome;
    const w1 = await wallet();
    const p1 = await payable();
    const lines = await ledgerOf(id);
    const row = await tx.homeBooking.findUniqueOrThrow({ where: { id }, select: { feeMinor: true, refundedMinor: true, advanceStatus: true } });
    const wantStatus =
      expect.fee === 0 ? AdvanceStatus.RELEASED : expect.fee === advanceMinor ? AdvanceStatus.FORFEITED : AdvanceStatus.PARTIALLY_FORFEITED;

    const got = { fee: o.feeMinor, refund: o.refundMinor, salon: o.salonShareMinor, platform: o.platformShareMinor, credit: o.salonCreditMinor };
    check(`${label}: outcome`, JSON.stringify(got) === JSON.stringify(expect), JSON.stringify(got));
    check(
      `${label}: booking row`,
      row.feeMinor === expect.fee && row.refundedMinor === expect.refund && row.advanceStatus === wantStatus,
      `fee ${row.feeMinor} refunded ${row.refundedMinor} ${row.advanceStatus}`,
    );
    check(`${label}: wallet held back to start`, w1.heldBalance === w0.heldBalance, `held ${w0.heldBalance} → ${w1.heldBalance}`);
    check(
      `${label}: wallet balance −fee +credit`,
      w1.balance === w0.balance - expect.fee + expect.credit,
      `${w0.balance} → ${w1.balance}`,
    );
    check(`${label}: journal sums to 0`, sumOf(lines) === 0 && lines.every((l) => l.journalId === id), `sum ${sumOf(lines)}`);
    check(
      `${label}: salon payable +share −credit, revenue +platform`,
      p1 - p0 === expect.salon - expect.credit && sumOf(lines, LedgerAccount.PLATFORM_REVENUE) === expect.platform,
      `payable ${p1 - p0}, revenue ${sumOf(lines, LedgerAccount.PLATFORM_REVENUE)}`,
    );
    check(`${label}: no zero lines`, lines.every((l) => l.amountMinor !== 0), `${lines.length} line(s)`);
    return { id, lines };
  };

  const now = new Date();

  // ------------------------------------------------------------ launch (FREE, all 0)
  const launch: HomePolicy = {
    ...live,
    policy: "FREE",
    lateCancelPercent: 0,
    noShowPercent: 0,
    nonRefundableGraceMinutes: 0,
    salonCancelCreditMinor: 0,
    feeSalonSharePercent: 100,
  };
  const full: Expect = { fee: 0, refund: ADVANCE, salon: 0, platform: 0, credit: 0 };
  for (const [label, event] of ALL_EVENTS(now)) {
    const { lines } = await runCase(`launch · ${label}`, event, launch, full);
    check(`launch · ${label}: no ledger lines at all`, lines.length === 0, `${lines.length}`);
  }
  await runCase("launch · cancel with balance paid in app", { kind: "CUSTOMER_CANCEL", now }, launch, full, { balanceInApp: true });

  // ------------------------------------------------------------ fees on: WINDOW 50 / no-show 100 / credit ৳20 / share 70
  const windowed: HomePolicy = {
    ...launch,
    policy: "WINDOW",
    freeCancelHours: 3,
    lateCancelPercent: 50,
    noShowPercent: 100,
    salonCancelCreditMinor: 2000,
    feeSalonSharePercent: 70,
  };
  const all: Expect = { fee: ADVANCE, refund: 0, salon: 45500, platform: 19500, credit: 0 };
  const half: Expect = { fee: 32500, refund: 32500, salon: 22750, platform: 9750, credit: 0 };
  const credited: Expect = { ...full, credit: 2000 };
  await runCase("WINDOW · cancel 24 h ahead", { kind: "CUSTOMER_CANCEL", now }, windowed, full);
  await runCase("WINDOW · cancel 1 h ahead", { kind: "CUSTOMER_CANCEL", now: new Date() }, windowed, half, { startsIn: HOUR - 2 * HOUR * slot });
  await runCase("WINDOW · cancel EN_ROUTE (24 h ahead)", { kind: "CUSTOMER_CANCEL", now }, windowed, half, { status: HomeBookingStatus.EN_ROUTE });
  await runCase("WINDOW · late cancel rounds to whole taka", { kind: "CUSTOMER_CANCEL", now: new Date() }, windowed, {
    fee: 32500,
    refund: 32550,
    salon: 22750,
    platform: 9750,
    credit: 0,
  }, { advanceMinor: 65050, startsIn: HOUR - 2 * HOUR * slot });
  await runCase("WINDOW · customer no-show", { kind: "CUSTOMER_NO_SHOW" }, windowed, all);
  await runCase("WINDOW · mismatch abort", { kind: "MISMATCH_ABORT" }, windowed, all);
  await runCase("WINDOW · salon cancel", { kind: "SALON_CANCEL" }, windowed, credited);
  await runCase("WINDOW · expert no-show", { kind: "EXPERT_NO_SHOW" }, windowed, credited);
  await runCase("WINDOW · admin cancel (salon at fault)", { kind: "ADMIN_CANCEL", salonAtFault: true }, windowed, credited);
  await runCase("WINDOW · admin cancel (not at fault)", { kind: "ADMIN_CANCEL", salonAtFault: false }, windowed, full);
  await runCase("WINDOW · system cancel", { kind: "SYSTEM_CANCEL" }, windowed, full);
  await runCase("WINDOW · safety abort", { kind: "SAFETY_ABORT" }, windowed, full);
  await runCase("WINDOW · salon cancel, balance paid in app", { kind: "SALON_CANCEL" }, windowed, credited, { balanceInApp: true });

  // ------------------------------------------------------------ NON_REFUNDABLE, without and with grace
  const nonRefundable: HomePolicy = { ...windowed, policy: "NON_REFUNDABLE", noShowPercent: 0, nonRefundableGraceMinutes: 0 };
  const grace: HomePolicy = { ...nonRefundable, nonRefundableGraceMinutes: 30 };
  await runCase("NON_REFUNDABLE · cancel (no grace)", { kind: "CUSTOMER_CANCEL", now }, nonRefundable, all, { confirmedAgo: 5 * MIN });
  await runCase("NON_REFUNDABLE · no-show (noShowPercent 0 still 100%)", { kind: "CUSTOMER_NO_SHOW" }, nonRefundable, all);
  await runCase("NON_REFUNDABLE · salon cancel", { kind: "SALON_CANCEL" }, nonRefundable, credited);
  await runCase("grace · cancel 10 min after paying, 24 h ahead", { kind: "CUSTOMER_CANCEL", now: new Date() }, grace, full, { confirmedAgo: 10 * MIN });
  await runCase("grace · cancel 40 min after paying", { kind: "CUSTOMER_CANCEL", now: new Date() }, grace, all, { confirmedAgo: 40 * MIN });
  await runCase("grace · in time but visit 1 h away", { kind: "CUSTOMER_CANCEL", now: new Date() }, grace, all, {
    confirmedAgo: 10 * MIN,
    startsIn: HOUR - 2 * HOUR * slot,
  });

  // ------------------------------------------------------------ snapshot beats the policy in force
  // The "current" policy here is the NON_REFUNDABLE one above; the booking keeps FREE.
  await runCase("snapshot · FREE booking under a NON_REFUNDABLE 'current' policy", { kind: "CUSTOMER_CANCEL", now }, launch, full);

  // ------------------------------------------------------------ appeal reversal
  const w0 = await wallet();
  const p0 = await payable();
  const appealed = await runCase("appeal · WINDOW no-show kept 100%", { kind: "CUSTOMER_NO_SHOW" }, windowed, all);
  await tx.homeBooking.update({ where: { id: appealed.id }, data: { appealStatus: "PENDING", appealedAt: new Date(), appealReason: "verify" } });
  const reversed = await reverseFeeTx(tx, appealed.id);
  const again = await reverseFeeTx(tx, appealed.id);
  const after = await ledgerOf(appealed.id);
  const w1 = await wallet();
  const row = await tx.homeBooking.findUniqueOrThrow({ where: { id: appealed.id }, select: { feeMinor: true, refundedMinor: true, advanceStatus: true } });
  check("appeal · reversal returns the fee", reversed?.refundedMinor === ADVANCE, JSON.stringify(reversed));
  check("appeal · reversal is idempotent", again === null);
  check("appeal · booking + reversal journals sum to 0", sumOf(after) === 0, `sum ${sumOf(after)}, ${after.length} lines`);
  check(
    "appeal · salon and platform back to where they were",
    (await payable()) === p0 && sumOf(after, LedgerAccount.PLATFORM_REVENUE) === 0,
    `payable Δ ${(await payable()) - p0}`,
  );
  check("appeal · wallet back to start, held 0", w1.balance === w0.balance && w1.heldBalance === w0.heldBalance, `${w0.balance} → ${w1.balance}`);
  check(
    "appeal · row: fee 0, all refunded, RELEASED",
    row.feeMinor === 0 && row.refundedMinor === ADVANCE && row.advanceStatus === AdvanceStatus.RELEASED,
    JSON.stringify(row),
  );

  // ------------------------------------------------------------ totals and the no-show block
  const end = await wallet();
  check("wallet held is 0 after every case", end.heldBalance === 0, `held ${end.heldBalance}`);
  const noShows = await tx.homeBooking.count({ where: { customerId: customer.id, status: HomeBookingStatus.NO_SHOW, noShowParty: "CUSTOMER" } });
  const block = await tx.homeCustomerBlock.findUnique({ where: { userId: customer.id } });
  if (threshold > 0 && noShows >= threshold) {
    check(`no-show block after ≥ ${threshold} no-shows`, block?.source === "NO_SHOWS" && block.until > new Date(), `${noShows} no-shows`);
  } else {
    check("no-show block: not enough no-shows to judge", true, `skip: threshold ${threshold}, ${noShows} no-shows`);
  }
  const unbalanced = await tx.$queryRaw<Array<{ journalId: string }>>`
    SELECT "journalId" FROM ledger_entries WHERE "homeBookingId" IS NOT NULL
    GROUP BY "journalId" HAVING SUM("amountMinor") <> 0`;
  check("every home journal (incl. fixtures) sums to 0", unbalanced.length === 0, `${unbalanced.length} unbalanced`);

  // ------------------------------------------------------------ gender in raw SQL
  /** The constraint that refused `sql`, or null when it was accepted. Undone either way. */
  const refusedBy = async (sql: Prisma.Sql) => {
    await tx.$executeRaw`SAVEPOINT verify_home_sql`;
    try {
      await tx.$executeRaw(sql);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT verify_home_sql`;
      return null;
    } catch (error) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT verify_home_sql`;
      return String(error instanceof Error ? error.message : error);
    }
  };
  const maleUser = await tx.user.create({
    data: { email: `verify-home-male-${tag}@seed.example.com`, name: "Verify Male", role: UserRole.STAFF, gender: Gender.MALE, isTest: true },
  });
  const maleStaff = await tx.staff.create({ data: { userId: maleUser.id, salonId: salon.id } });
  const insertExpert = (gender: string, audience: string) => Prisma.sql`
    INSERT INTO home_experts (id, "staffId", "salonId", gender, audience, languages, "updatedAt")
    VALUES (${randomUUID()}, ${maleStaff.id}, ${salon.id}, ${gender}::"Gender", ${audience}::"HomeAudience", '{}', now())`;
  const genderRule = "home_experts_gender_audience";
  check("raw SQL · FEMALE + GENTS expert refused", (await refusedBy(insertExpert("FEMALE", "GENTS")))?.includes(genderRule) === true);
  check("raw SQL · MALE + LADIES expert refused", (await refusedBy(insertExpert("MALE", "LADIES")))?.includes(genderRule) === true);
  check("raw SQL · MALE + GENTS expert accepted (the rule, not a broken insert)", (await refusedBy(insertExpert("MALE", "GENTS"))) === null);
  const mismatch = await book({ status: HomeBookingStatus.CONFIRMED, snapshot: launch });
  check(
    "raw SQL · a booking's audience can't differ from its expert's",
    (await refusedBy(Prisma.sql`UPDATE home_bookings SET "expertAudience" = 'GENTS' WHERE id = ${mismatch}`))?.includes("home_bookings_audience_match") === true,
  );
  const [overlapOf] = await tx.$queryRaw<Array<{ blockFrom: Date; blockTo: Date }>>`SELECT "blockFrom", "blockTo" FROM home_bookings WHERE id = ${mismatch}`;
  const overlapping = await book({ status: HomeBookingStatus.CONFIRMED, snapshot: launch });
  check(
    "raw SQL · overlapping active visits of one expert refused",
    (
      await refusedBy(
        Prisma.sql`UPDATE home_bookings SET "blockFrom" = ${overlapOf.blockFrom}::timestamptz, "blockTo" = ${overlapOf.blockTo}::timestamptz WHERE id = ${overlapping}`,
      )
    )?.includes("home_bookings_no_overlap") === true,
  );

  // ------------------------------------------------------------ report money
  // A visit at each edge of one Dhaka day, one just before it, 10% commission.
  const day = addDays(dhakaDay(), -2);
  const edge = dayStart(day).getTime();
  const completed = async (completedAt: Date) => {
    const id = await book({ status: HomeBookingStatus.CONFIRMED, snapshot: launch });
    await tx.homeBooking.update({
      where: { id },
      data: { status: HomeBookingStatus.COMPLETED, completedAt, commissionBps: 1000, subtotalMinor: 120000, travelFeeMinor: 10000 },
    });
    await settleHomeCompletedTx(tx, id);
    return id;
  };
  await completed(new Date(edge + 10 * MIN)); // 00:10 Dhaka, still the day before in UTC
  await completed(new Date(edge + 24 * HOUR - 10 * MIN)); // 23:50 Dhaka
  await completed(new Date(edge - 10 * MIN)); // 23:50 Dhaka the day before
  const f = { from: dayStart(addDays(day, -1)), to: dayStart(addDays(day, 1)), salonIds: [salon.id], includeTest: true };
  const reportDays = async () => {
    const found = await getHomeDailyMoney(f, tx);
    return found.map((d) => `${d.day} ${d.audience} ${d.visits} ${d.subtotalMinor} ${d.travelFeeMinor} ${d.commissionMinor}`).join(" | ");
  };
  const wantDays = `${addDays(day, -1)} LADIES 1 120000 10000 12000 | ${day} LADIES 2 240000 20000 24000`;
  const utcDays = await reportDays();
  check("report · visits fall on their Dhaka day; travel fee not commissioned", utcDays === wantDays, utcDays);
  await tx.$executeRaw`SET LOCAL timezone = 'America/New_York'`;
  check("report · the session time zone doesn't move a day", (await reportDays()) === wantDays);
  await tx.$executeRaw`SET LOCAL timezone = 'UTC'`;
  check("report · test salons are left out by default", (await getHomeDailyMoney({ ...f, includeTest: false }, tx)).length === 0);

  const advances = await getHomeAdvances(f, tx);
  const heldNow = await tx.homeBooking.aggregate({ where: { salonId: salon.id, advanceStatus: AdvanceStatus.HELD }, _sum: { advanceMinor: true }, _count: true });
  check("report · advances held = HELD rows, whatever the range", advances.heldMinor === (heldNow._sum.advanceMinor ?? 0) && advances.heldVisits === heldNow._count, JSON.stringify(advances));
  check("report · advances settled = the 3 completed visits", advances.settledMinor === 3 * ADVANCE && advances.settledVisits === 3);

  const ever = { from: new Date(Date.now() - HOUR), to: new Date(Date.now() + HOUR), salonIds: [salon.id], includeTest: true };
  const outcomes = await getHomeOutcomes(ever, "ended", tx);
  const paidEnds = await tx.homeBooking.aggregate({
    where: { salonId: salon.id, status: { in: [HomeBookingStatus.CANCELLED, HomeBookingStatus.NO_SHOW] } },
    _sum: { feeMinor: true, refundedMinor: true },
    _count: true,
  });
  const summed = outcomes.reduce((s, o) => ({ n: s.n + o.visits, fee: s.fee + o.feeMinor, back: s.back + o.refundedMinor }), { n: 0, fee: 0, back: 0 });
  check(
    "report · outcomes add up to the bookings",
    summed.n === paidEnds._count && summed.fee === (paidEnds._sum.feeMinor ?? 0) && summed.back === (paidEnds._sum.refundedMinor ?? 0),
    JSON.stringify(summed),
  );
  const refundedOnly = (side: string) => outcomes.filter((o) => o.side === side).every((o) => o.feeMinor === 0);
  check("report · salon, admin, system and safety ends keep nothing", ["SALON", "ADMIN", "SYSTEM", "SAFETY"].every(refundedOnly));
  check(
    "report · a mismatch at the door is its own side and can keep a fee",
    outcomes.some((o) => o.side === "MISMATCH" && o.feeMinor > 0) && outcomes.some((o) => o.side === "SAFETY"),
  );
  check(
    "report · both no-show sides are told apart",
    outcomes.some((o) => o.side === "CUSTOMER_NO_SHOW") && outcomes.some((o) => o.side === "EXPERT_NO_SHOW"),
    [...new Set(outcomes.map((o) => o.side))].join(", "),
  );
  check("report · outcomes keep each booking's policy", new Set(outcomes.map((o) => o.policy)).size === 3, [...new Set(outcomes.map((o) => o.policy))].join(", "));

  throw new Rollback();
};

const main = async () => {
  checkCoverage(check);
  checkWindow(check);
  try {
    await prisma.$transaction(run, { timeout: 600_000, maxWait: 15_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      check("scenario ran to the end", false, error instanceof Error ? error.message : String(error));
    }
  }

  if (onHomeBranch) {
    try {
      await runLive(check);
    } catch (error) {
      check("access and races ran to the end", false, error instanceof Error ? error.message : String(error));
    }
  }

  const width = Math.max(...rows.map((row) => row.check.length));
  for (const row of rows) {
    console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.check.padEnd(width)}  ${row.detail}`);
  }
  const failed = rows.filter((row) => !row.ok).length;
  const verdict = failed ? "FAILED" : onHomeBranch ? "passed" : "INCOMPLETE";
  console.log(`\nverify:home ${verdict}: ${rows.length - failed}/${rows.length}`);
  if (!onHomeBranch) console.log("NOT RUN: access matrix, API gender and window cases, races. They need the test branch.");
  await prisma.$disconnect();
  process.exit(failed ? 1 : onHomeBranch ? 0 : 2);
};

void main();
