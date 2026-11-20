/**
 * The database half of `verify:referral` (sections 2–10). Runs only on the
 * test database: `verifyReferral.ts` refuses anything else before calling it.
 *
 * Real service paths throughout (register, verify-otp, Google, bookAppointment,
 * checkout, cancel, no-show, appeal, reschedule, home quote / create / pay /
 * complete / expire, endVisitTx, the jobs). Cases that only need one
 * transaction run inside one that is rolled back; the rest commit isTest rows
 * that the caller removes at the end.
 */
import { randomUUID } from "crypto";
import {
  AdvanceStatus,
  AppointmentSource,
  AppointmentStatus,
  HomeAudience,
  HomeBookingStatus,
  LedgerAccount,
  Prisma,
  RewardStatus,
  UserRole,
  WalletTxType,
} from "@prisma/client";
import config from "../config";
import ApiError from "../app/Error/error";
import prisma from "../app/shared/prisma";
import { AuthService } from "../app/modules/Auth/auth.service";
import { resolveGoogleAccount } from "../app/modules/Auth/auth.google";
import {
  attachOnSignupTx,
  onEmailVerified,
  precheckSignupCode,
  prepareAttach,
  type SignupReferralCtx,
} from "../app/modules/Referral/referral.attach";
import { ensureCode, findReferrerByCode } from "../app/modules/Referral/referral.codes";
import { hmac, type SignupSignals } from "../app/modules/Referral/referral.risk";
import { rewardDiscountMinor } from "../app/modules/Referral/referral.math";
import { reserveTx } from "../app/modules/Referral/referral.rewards";
import { approveReferral, rejectReferral } from "../app/modules/Referral/referral.admin";
import { runReferralExpire, runReferralReconcile, runReferralReminders } from "../app/modules/Referral/referral.jobs";
import { AppointmentService } from "../app/modules/Appointment/appointment.service";
import { AppointmentCheckout } from "../app/modules/Appointment/appointment.checkout";
import { AppointmentCalendar } from "../app/modules/Appointment/appointment.calendar";
import { AppointmentDeposit } from "../app/modules/Appointment/appointment.deposit";
import { billableMinor, paymentSummary } from "../app/modules/Appointment/appointment.billing";
import {
  PROMO_PLATFORM_DESCRIPTION,
  PROMO_SALON_DESCRIPTION,
  resolveCommissionMinor,
} from "../app/modules/Settlement/settlement.service";
import { getPlatformEarnings } from "../app/modules/Settlement/settlement.earnings";
import { confirmPaidHomeBooking, createBooking, quote as homeQuote } from "../app/modules/HomeService/home.booking";
import { completeJob } from "../app/modules/HomeService/home.lifecycle";
import { expireUnpaidHomeBookings } from "../app/modules/HomeService/home.jobs";
import { endVisitTx, type EndEvent } from "../app/modules/HomeService/home.cancel";
import { availableFor } from "../app/modules/HomeService/home.availability";
import { homeCommissionMinor } from "../app/modules/HomeService/home.money";
import { currentPolicy, policySnapshotOf } from "../app/modules/HomeService/home.policy";
import { WalletService } from "../app/modules/Wallet/wallet.service";
import { addDays, dhakaDay } from "../app/modules/Analytics/analytics.days";
import { systemAuditCtx } from "../app/utils/audit";
import {
  DAY,
  HOME_PRICE,
  HOUR,
  LAT,
  LNG,
  MIN,
  PRICE,
  TAG,
  bookingBody,
  emailOf,
  freshPhone,
  grantRow,
  joinedReferee,
  person,
  referrer,
  rewardOf,
  setSettings,
  slot,
  timeTravel,
  track,
  wallClock,
  type Check,
  type World,
} from "./verifyReferral.fixtures";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code?: string; message: string; details?: Record<string, unknown> };

const attempt = async <T>(fn: () => Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.statusCode, code: e.errorCode, message: e.message, details: e.details };
    if (e instanceof Prisma.PrismaClientKnownRequestError) return { ok: false, status: 500, code: e.code, message: e.message };
    return { ok: false, status: 500, message: e instanceof Error ? e.message : String(e) };
  }
};

const said = (o: Outcome<unknown>) =>
  o.ok ? "ok" : `${o.status}${o.code ? ` ${o.code}` : ""}: ${o.message.split("\n").filter(Boolean).pop()?.slice(0, 120)}`;

const errMsg = (e: unknown) => (e instanceof Error ? e.message.split("\n").filter(Boolean).pop() ?? e.message : String(e));

class Rollback extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => Promise<boolean>, ms = 6000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await sleep(100);
  }
};

const sum = (lines: Array<{ amountMinor: number }>) => lines.reduce((s, l) => s + l.amountMinor, 0);

/** What the flows hand on: completed bookings for the money section, ids for the access matrix. */
export type FlowResult = {
  completedSalon: string[];
  completedHome: string[];
  access: {
    customer: string;
    otherCustomer: string;
    customerRewardId: string;
    /** A customer and one of their own rewards that is no longer AVAILABLE. */
    used: { userId: string; rewardId: string };
    referralId: string;
    slotBody: (slotId: string) => Record<string, unknown>;
    freshSlot: () => Promise<string>;
  } | null;
};

// ---------------------------------------------------------------------------

export const runFlows = async (check: Check, w: World, runStart: Date): Promise<FlowResult> => {
  const completedSalon: string[] = [];
  const completedHome: string[] = [];
  const out: FlowResult = { completedSalon, completedHome, access: null };

  const section = async (title: string, fn: () => Promise<void>) => {
    console.log(`\n${title}`);
    try {
      await fn();
    } catch (e) {
      check(`${title}: ran to the end`, false, errMsg(e));
    }
  };

  const rolledBack = async (label: string, fn: (tx: Tx) => Promise<void>) => {
    try {
      await prisma.$transaction(
        async (tx) => {
          await fn(tx);
          throw new Rollback();
        },
        { timeout: 120_000, maxWait: 15_000 },
      );
    } catch (e) {
      if (!(e instanceof Rollback)) check(`${label}: ran to the end`, false, errMsg(e));
    }
  };

  const ctxOf = (s: Partial<SignupSignals> = {}): SignupReferralCtx => ({
    channel: "CODE",
    signals: () => ({ ipHash: s.ipHash ?? null, deviceHash: s.deviceHash ?? null }),
  });

  // Codes printed by the OTP engine (`devLogOtp`), so verify-otp runs for real.
  const otpCodes = new Map<string, string>();
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    const m = typeof args[0] === "string" ? /^\[otp:dev\] (\S+) -> (\d+)$/.exec(args[0]) : null;
    if (m) {
      otpCodes.set(m[1].toLowerCase(), m[2]);
      return;
    }
    realLog(...args);
  };
  const authBefore = { ...config.auth };
  const googleOtpBefore = config.google.signupRequiresOtp;
  config.auth.requireEmailVerification = true;
  config.auth.devLogOtp = true;

  const userCount = (email: string) => prisma.user.count({ where: { email: { equals: email, mode: "insensitive" } } });

  /** POST /auth/register, in process. Marks a created user isTest. */
  const signUp = async (
    key: string,
    code: string | undefined,
    o: { phone?: string | null; email?: string; role?: string; signals?: Partial<SignupSignals> } = {},
  ) => {
    const email = (o.email ?? emailOf(key)).toLowerCase();
    const res = await attempt(() =>
      AuthService.register(
        {
          email,
          password: "Verify-pass-123",
          name: `Verify ${key}`,
          phone: o.phone === undefined ? freshPhone() : (o.phone ?? undefined),
          ...(code ? { referralCode: code } : {}),
          ...(o.role ? { role: o.role } : {}),
        },
        null,
        ctxOf(o.signals),
      ),
    );
    let userId: string | null = null;
    if (res.ok) {
      const u = await prisma.user.findFirstOrThrow({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } });
      track(u.id);
      await prisma.user.update({ where: { id: u.id }, data: { isTest: true } });
      userId = u.id;
    }
    return { res, userId, email };
  };

  const referralOf = (refereeId: string) => prisma.referral.findUnique({ where: { refereeId }, include: { rewards: true } });

  const refusal = async (label: string, key: string, code: string, want: string, o: Parameters<typeof signUp>[2] = {}) => {
    const r = await signUp(key, code, o);
    const left = await userCount(r.email);
    check(
      `attach: ${label} → 400 ${want}, no user created`,
      !r.res.ok && r.res.status === 400 && r.res.code === want && r.res.details?.field === "referralCode" && left === 0,
      `${said(r.res)}; users ${left}`,
    );
  };

  // Salon helpers -----------------------------------------------------------
  let day = 1;
  const nextDay = () => day++;
  const book = (userId: string, slotId: string, rewardId?: string | null) =>
    attempt(() => AppointmentService.bookAppointment(userId, bookingBody(w, slotId, rewardId)));
  const quoteSalon = (userId: string, slotId: string, rewardId?: string | null) =>
    attempt(() => AppointmentService.quoteAppointment(userId, bookingBody(w, slotId, rewardId) as never));
  const complete = async (appointmentId: string) => {
    await timeTravel(appointmentId, -10);
    return attempt(() => AppointmentCheckout.checkout(w.ownerActor, appointmentId, { paymentMethod: "CASH" }));
  };
  const reward = (id: string | null | undefined) => (id ? rewardOf(id) : Promise.resolve(null));

  /** A completed appointment written straight into `tx` and settled the way checkout settles it. */
  const settleIn = async (
    tx: Tx,
    customerId: string,
    o: { source?: AppointmentSource; totalMinor?: number; completedById?: string | null } = {},
  ) => {
    const { date } = wallClock(new Date());
    const a = await tx.appointment.create({
      data: {
        customerId,
        salonId: w.salonId,
        serviceId: w.serviceId,
        counterId: w.counterId,
        appointmentDate: date,
        startTime: "10:00",
        endTime: "11:00",
        status: AppointmentStatus.COMPLETED,
        completedAt: new Date(),
        completedById: o.completedById === undefined ? w.owner.id : o.completedById,
        source: o.source ?? AppointmentSource.PLATFORM,
        totalMinor: o.totalMinor ?? PRICE,
        depositMinor: 0,
        commissionBps: 1000,
      },
    });
    await AppointmentDeposit.settleCompletedTx(tx, a.id);
    return a.id;
  };

  // Home helpers -------------------------------------------------------------
  const homeActor = (userId: string) => ({ userId });
  const homeBody = (startAt: Date, extra: Record<string, unknown> = {}) => ({
    salonId: w.salonId,
    audience: HomeAudience.LADIES,
    offeringIds: [w.offeringId],
    expertId: w.expertId,
    date: dhakaDay(startAt),
    startAt: startAt.toISOString(),
    lat: LAT,
    lng: LNG,
    addressLine: "House 1, Road 1, Mirpur",
    recipientName: "Verify",
    recipientIsWoman: true,
    contactPhone: "01711111111",
    ...extra,
  });
  const usedHomeStarts = new Set<number>();
  const homeStart = async () => {
    for (let d = 1; d <= 6; d++) {
      const dd = addDays(dhakaDay(), d);
      const { byDay } = await availableFor({ expertId: w.expertId, offeringIds: [w.offeringId], days: [dd], now: new Date() });
      const s = (byDay.get(dd) ?? []).find((x) => !usedHomeStarts.has(x.startAt.getTime()) && ![...usedHomeStarts].some((t) => Math.abs(t - x.startAt.getTime()) < 3 * HOUR));
      if (s) {
        usedHomeStarts.add(s.startAt.getTime());
        return s.startAt;
      }
    }
    throw new Error("no home slot in the next 6 days");
  };

  // Referrers used across sections.
  const R1 = await referrer("r1");
  const R2 = await referrer("r2");
  const R3 = await referrer("r3");
  const R4 = await referrer("r4");
  const R5 = await referrer("r5");

  try {
    // =======================================================================
    await section("2. Attach", async () => {
      const a = await signUp("attach-a", R1.code);
      const ticket = a.res.ok ? (a.res.value as { ticket?: string }).ticket : undefined;
      const pending = a.userId ? await referralOf(a.userId) : null;
      check(
        "attach: valid code at sign-up → PENDING_VERIFICATION, no reward yet",
        a.res.ok && pending?.status === "PENDING_VERIFICATION" && pending.referrerId === R1.id && pending.rewards.length === 0,
        a.res.ok ? `${pending?.status}, ${pending?.rewards.length} reward(s)` : said(a.res),
      );
      const code = otpCodes.get(a.email);
      const verified = ticket && code ? await attempt(() => AuthService.verifyOtp({ ticket, code })) : null;
      const joined =
        !!a.userId &&
        (await waitFor(async () => (await referralOf(a.userId!))?.status === "JOINED" && ((await referralOf(a.userId!))?.rewards.length ?? 0) > 0));
      const after = a.userId ? await referralOf(a.userId) : null;
      const welcome = after?.rewards.find((r) => r.kind === "REFEREE_WELCOME");
      check("attach: verify-otp → JOINED + welcome reward", !!verified?.ok && joined && !!welcome && !!after?.joinedAt, verified ? said(verified) : "no OTP captured");
      check(
        "attach: welcome snapshot = settings (5% · cap ৳300 · ALL · first booking · 30 d)",
        !!welcome &&
          welcome.status === "AVAILABLE" &&
          welcome.percentBps === 500 &&
          welcome.maxDiscountMinor === 30000 &&
          welcome.scope === "ALL" &&
          welcome.firstBookingOnly &&
          Math.abs(welcome.expiresAt.getTime() - Date.now() - 30 * DAY) < 5 * MIN,
        welcome ? `${welcome.status} ${welcome.percentBps} bps, cap ${welcome.maxDiscountMinor}, ${welcome.scope}` : "none",
      );

      // Hard refusals: the person can fix the field; nothing is created.
      const self = await precheckSignupCode({ code: R1.code, email: R1.email, userId: R1.id });
      check("attach: own code → REFERRAL_SELF", !self.ok && self.code === "REFERRAL_SELF", self.ok ? "ok" : self.code);
      const sameEmail = await signUp("attach-self", R1.code, { email: R1.email.toUpperCase() });
      check("attach: the referrer's own email (any case) → refused, no second user", !sameEmail.res.ok && (await userCount(R1.email)) === 1, said(sameEmail.res));

      const gmailRef = await referrer("gmail-ref", { email: `ref.verify.${TAG}@gmail.com` });
      await refusal("Gmail alias of the referrer (dots + +tag)", "gmail-alias", gmailRef.code, "REFERRAL_SELF", {
        email: `refverify${TAG}+promo@googlemail.com`,
      });
      // Back on the marker domain at once: no mail can ever go to it.
      await prisma.user.update({ where: { id: gmailRef.id }, data: { email: emailOf("gmail-ref") } });

      await refusal("the referrer's phone", "same-phone", R1.code, "REFERRAL_SELF", { phone: R1.phone });

      const blocked = await referrer("blocked");
      await prisma.referralCode.update({ where: { userId: blocked.id }, data: { blockedAt: new Date(), blockedReason: "verify" } });
      await refusal("blocked code", "via-blocked", blocked.code, "REFERRAL_CODE_INVALID");

      const ownerCode = await ensureCode(w.owner.id);
      await refusal("non-customer referrer (salon owner)", "via-owner", ownerCode.code, "REFERRAL_CODE_INVALID");

      const unverified = await referrer("unverified", { emailVerified: false, emailVerifiedAt: null });
      await refusal("unverified referrer", "via-unverified", unverified.code, "REFERRAL_CODE_INVALID");

      await refusal("unknown code", "via-unknown", "ZZZZZZ22", "REFERRAL_CODE_INVALID");

      await setSettings({ "referral.enabled": false });
      await refusal("program off", "program-off", R1.code, "REFERRAL_PROGRAM_OFF");
      await setSettings({ "referral.enabled": true });

      const owner = await signUp("owner-with-code", R1.code, { role: "SALON_OWNER" });
      const ownerRef = owner.userId ? await prisma.referral.count({ where: { refereeId: owner.userId } }) : -1;
      check("attach: owner sign-up with a code → account made, no referral", owner.res.ok && ownerRef === 0, `${said(owner.res)}; referrals ${ownerRef}`);

      // Google: created attaches, existing says REFERRAL_NOT_NEW_ACCOUNT.
      config.google.signupRequiresOtp = false;
      const sub = `verify-referral-${TAG}`;
      const gEmail = emailOf("google");
      const g = { sub, email: gEmail, email_verified: true, name: "Verify google", iss: "accounts.google.com", aud: "verify", iat: 0, exp: 0 };
      const created = await attempt(() => resolveGoogleAccount(g as never, null, { rf: R1.code, referral: ctxOf() }));
      const gUser = await prisma.user.findFirst({ where: { email: gEmail }, select: { id: true } });
      if (gUser) {
        track(gUser.id);
        await prisma.user.update({ where: { id: gUser.id }, data: { isTest: true } });
      }
      const gRef = gUser ? await referralOf(gUser.id) : null;
      check(
        "attach: Google created → applied, JOINED + welcome",
        created.ok &&
          created.value.linked === "created" &&
          (created.value.result as { referral?: { applied: boolean } }).referral?.applied === true &&
          gRef?.status === "JOINED" &&
          gRef.rewards.some((r) => r.kind === "REFEREE_WELCOME"),
        created.ok ? `${created.value.linked}, ${gRef?.status}` : said(created),
      );
      const again = await attempt(() => resolveGoogleAccount(g as never, null, { rf: R2.code, referral: ctxOf() }));
      const gRefs = gUser ? await prisma.referral.findMany({ where: { refereeId: gUser.id } }) : [];
      check(
        "attach: Google existing → REFERRAL_NOT_NEW_ACCOUNT, referral unchanged",
        again.ok &&
          again.value.linked === "existing" &&
          (again.value.result as { referral?: { applied: boolean; reason?: string } }).referral?.reason === "REFERRAL_NOT_NEW_ACCOUNT" &&
          gRefs.length === 1 &&
          gRefs[0].referrerId === R1.id,
        again.ok ? `${again.value.linked}, ${gRefs.length} referral(s)` : said(again),
      );
      config.google.signupRequiresOtp = googleOtpBefore;

      // A second attach for the same person cannot happen (refereeId @unique).
      const firstReferee = a.userId;
      if (firstReferee) {
        await rolledBack("attach twice", async (tx) => {
          const hit = await findReferrerByCode(R2.code);
          const prep = await prepareAttach(hit!, a.email);
          await tx.$executeRawUnsafe("SAVEPOINT attach_twice");
          let codeSeen = "none";
          try {
            await attachOnSignupTx(tx, { ...prep, refereeId: firstReferee, verified: true });
          } catch (e) {
            codeSeen = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : errMsg(e);
          }
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT attach_twice");
          check("attach: a second referral for the same referee → refused (unique)", codeSeen === "P2002", codeSeen);
        });
      }
    });

    // =======================================================================
    await section("3. Fraud flags", async () => {
      const Rf = await referrer("fraud");
      const device = randomUUID();
      const deviceHash = hmac(device);
      const ipHash = hmac("10.77.66.55");
      await prisma.referralCode.update({ where: { userId: Rf.id }, data: { deviceHashes: [deviceHash], ipHashes: [ipHash] } });

      const dev = await signUp("flag-device", Rf.code, { signals: { deviceHash } });
      const devRef = dev.userId ? await referralOf(dev.userId) : null;
      check("flags: SAME_DEVICE", !!devRef?.riskFlags.includes("SAME_DEVICE"), devRef ? devRef.riskFlags.join(",") || "none" : said(dev.res));
      check("flags: device hash stored, raw id never", devRef?.refereeDeviceHash === deviceHash && !JSON.stringify(devRef).includes(device), "");

      const net = await signUp("flag-network", Rf.code, { signals: { ipHash } });
      const netRef = net.userId ? await referralOf(net.userId) : null;
      check("flags: SAME_NETWORK", !!netRef?.riskFlags.includes("SAME_NETWORK") && !netRef.riskFlags.includes("SAME_DEVICE"), netRef?.riskFlags.join(",") ?? said(net.res));

      const Rv = await referrer("velocity");
      const vel: string[][] = [];
      for (let i = 1; i <= 6; i++) {
        const s = await signUp(`velocity-${i}`, Rv.code);
        vel.push(s.userId ? ((await referralOf(s.userId))?.riskFlags ?? ["?"]) : ["failed"]);
      }
      check(
        "flags: VELOCITY on the 6th attach in 24 h, not before",
        vel.slice(0, 5).every((f) => !f.includes("VELOCITY") && !f.includes("failed")) && vel[5].includes("VELOCITY"),
        vel.map((f) => f.join("+") || "-").join(" | "),
      );

      const disp = await prepareAttach((await findReferrerByCode(Rf.code))!, `ref-verify.${TAG}@yopmail.com`);
      check("flags: DISPOSABLE_EMAIL", disp.flags.includes("DISPOSABLE_EMAIL"), disp.flags.join(","));
      await rolledBack("disposable attach", async (tx) => {
        const u = await tx.user.create({ data: { email: `ref-verify.disposable.${TAG}@yopmail.com`, name: "Verify disposable", isTest: true } });
        await attachOnSignupTx(tx, { ...disp, refereeId: u.id, verified: false });
        const r = await tx.referral.findUnique({ where: { refereeId: u.id } });
        check("flags: DISPOSABLE_EMAIL saved on the referral", !!r?.riskFlags.includes("DISPOSABLE_EMAIL"), r?.riskFlags.join(",") ?? "none");
      });

      // AUTO_CLOSED: the stale-checkout job completes the qualifying booking.
      const Ra = await referrer("autoclose");
      const ac = await joinedReferee("autoclose-friend", Ra, { welcome: false });
      const old = wallClock(new Date(Date.now() - 2 * DAY));
      const stale = await prisma.appointment.create({
        data: {
          customerId: ac.id,
          salonId: w.salonId,
          serviceId: w.serviceId,
          counterId: w.counterId,
          appointmentDate: old.date,
          startTime: old.time,
          endTime: wallClock(new Date(Date.now() - 2 * DAY + HOUR)).time,
          status: AppointmentStatus.CHECKED_IN,
          checkedInAt: new Date(Date.now() - 2 * DAY),
          checkedInById: w.owner.id,
          source: AppointmentSource.PLATFORM,
          totalMinor: PRICE,
          depositMinor: 0,
          commissionBps: 1000,
        },
      });
      await AppointmentCheckout.autoCloseStaleCheckIns();
      const closed = await prisma.appointment.findUnique({ where: { id: stale.id }, select: { status: true, completedById: true } });
      const acRef = await referralOf(ac.id);
      const acBonus = await prisma.referralReward.findFirst({ where: { referralId: ac.referralId, kind: "REFERRER_BONUS" } });
      check(
        "flags: AUTO_CLOSED (stale close) → QUALIFIED, referrer reward held",
        closed?.status === "COMPLETED" && closed.completedById === null && acRef?.status === "QUALIFIED" && !!acRef.riskFlags.includes("AUTO_CLOSED") && acBonus?.status === "PENDING_REVIEW",
        `${closed?.status}, ${acRef?.status} [${acRef?.riskFlags.join(",")}], bonus ${acBonus?.status ?? "none"}`,
      );
      if (closed?.status === "COMPLETED") completedSalon.push(stale.id);

      // PHONE_REUSED: one welcome per phone.
      const Rp = await referrer("phone");
      const phone = freshPhone();
      const pa = await joinedReferee("phone-a", Rp, { phone });
      const pb = await joinedReferee("phone-b", Rp, { phone });
      const paBook = await book(pa.id, (await slot(w, nextDay())).id);
      const paReward = await reward(pa.welcomeId);
      check("flags: first account books with its welcome (phone hash stored)", paBook.ok && paReward?.status === "RESERVED" && paReward.phoneHash === hmac(phone), said(paBook));
      const pbQuote = await quoteSalon(pb.id, (await slot(w, nextDay())).id);
      const pbRef = await referralOf(pb.id);
      check(
        "flags: same phone, second account → welcome not offered, PHONE_REUSED",
        pbQuote.ok && pbQuote.value.promo === null && !pbQuote.value.rewardOptions.some((o) => o.rewardId === pb.welcomeId) && !!pbRef?.riskFlags.includes("PHONE_REUSED"),
        pbQuote.ok ? `promo ${pbQuote.value.promo?.rewardId ?? "none"}, flags ${pbRef?.riskFlags.join(",")}` : said(pbQuote),
      );
      const pbAsk = await book(pb.id, (await slot(w, nextDay())).id, pb.welcomeId);
      check(
        "flags: asking for it anyway → 400 REWARD_NOT_APPLICABLE (PHONE_REUSED), nothing booked",
        !pbAsk.ok && pbAsk.status === 400 && pbAsk.code === "REWARD_NOT_APPLICABLE" && pbAsk.details?.reason === "PHONE_REUSED" &&
          (await prisma.appointment.count({ where: { customerId: pb.id } })) === 0,
        said(pbAsk),
      );
      await rolledBack("welcome phone index", async (tx) => {
        await tx.$executeRawUnsafe("SAVEPOINT phone_index");
        let seen = "none";
        try {
          await tx.$executeRaw`UPDATE referral_rewards SET status = 'RESERVED', "appointmentId" = ${randomUUID()}, "phoneHash" = ${hmac(phone)}, "reservedAt" = now() WHERE id = ${pb.welcomeId}`;
        } catch (e) {
          // The only unique key on phoneHash is the partial index referral_rewards_welcome_phone.
          seen = /referral_rewards_welcome_phone|23505[\s\S]*"phoneHash"/.test(String((e as Error).message)) ? "unique welcome_phone" : errMsg(e);
        }
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT phone_index");
        check("flags: the DB index refuses a second welcome on one phone", seen === "unique welcome_phone", seen);
      });
    });

    // =======================================================================
    await section("4. Race: 10 parallel bookings, one reward", async () => {
      const raceDays = Array.from({ length: 10 }, () => nextDay());

      const named = await joinedReferee("race-named", R2);
      const s1 = await Promise.all(raceDays.map((d) => slot(w, d, 12)));
      const r1 = await Promise.all(s1.map((s) => book(named.id, s.id, named.welcomeId)));
      const won1 = r1.filter((r) => r.ok);
      const lost1 = r1.filter((r) => !r.ok && r.status === 409 && r.code === "REWARD_UNAVAILABLE");
      const w1 = await reward(named.welcomeId);
      const appts1 = await prisma.appointment.findMany({ where: { customerId: named.id }, select: { id: true, promoDiscountMinor: true } });
      check(
        "race · named reward: exactly 1 booking, the other 9 → 409 REWARD_UNAVAILABLE",
        won1.length === 1 && lost1.length === 9 && appts1.length === 1,
        `${won1.length} ok, ${lost1.length} REWARD_UNAVAILABLE, others: ${r1.filter((r) => !r.ok && r.code !== "REWARD_UNAVAILABLE").map(said).join("; ") || "none"}`,
      );
      check(
        "race · named reward: it is RESERVED on the one booking",
        w1?.status === "RESERVED" && w1.appointmentId === appts1[0]?.id && appts1[0]?.promoDiscountMinor === 10000,
        `${w1?.status} on ${w1?.appointmentId === appts1[0]?.id ? "the winner" : w1?.appointmentId}`,
      );

      const auto = await joinedReferee("race-auto", R2);
      const s2 = await Promise.all(raceDays.map((d) => slot(w, d, 14)));
      const r2 = await Promise.all(s2.map((s) => book(auto.id, s.id)));
      const w2 = await reward(auto.welcomeId);
      const appts2 = await prisma.appointment.findMany({ where: { customerId: auto.id }, select: { id: true, promoDiscountMinor: true, promoLabel: true } });
      const withPromo = appts2.filter((a) => a.promoDiscountMinor > 0);
      check(
        "race · best reward (no id): all 10 book, exactly 1 holds the reward",
        r2.every((r) => r.ok) && appts2.length === 10 && withPromo.length === 1,
        `${r2.filter((r) => r.ok).length} ok (${r2.filter((r) => !r.ok).map(said).join("; ") || "no errors"}), ${withPromo.length} with a promo`,
      );
      check(
        "race · best reward: RESERVED on that booking, the rest at full price",
        w2?.status === "RESERVED" && w2.appointmentId === withPromo[0]?.id && appts2.filter((a) => a.promoDiscountMinor === 0 && a.promoLabel === null).length === 9,
        `${w2?.status}`,
      );
    });

    // =======================================================================
    await section("5. Salon lifecycle", async () => {
      const c1 = await joinedReferee("salon-1", R1);
      const slotA = await slot(w, nextDay());
      const q = await quoteSalon(c1.id, slotA.id);
      check(
        "salon: quote picks the welcome (5% of ৳2,000 = ৳100), due at salon ৳1,900",
        q.ok && q.value.promo?.rewardId === c1.welcomeId && q.value.promo.discountMinor === 10000 && q.value.totalMinor === PRICE && q.value.dueAtSalonMinor === PRICE - 10000,
        q.ok ? `promo ${q.value.promo?.discountMinor}, due ${q.value.dueAtSalonMinor}` : said(q),
      );
      const b1 = await book(c1.id, slotA.id);
      const a1 = b1.ok ? b1.value.id : "";
      const r1 = await reward(c1.welcomeId);
      const appt1 = a1 ? await prisma.appointment.findUnique({ where: { id: a1 } }) : null;
      check(
        "salon: book → RESERVED, booking carries the promo snapshot",
        r1?.status === "RESERVED" && r1.appointmentId === a1 && r1.discountMinor === 10000 && appt1?.promoDiscountMinor === 10000 && appt1.promoLabel === "Welcome reward (5%)",
        b1.ok ? `${r1?.status}, promo ${appt1?.promoDiscountMinor} "${appt1?.promoLabel}"` : said(b1),
      );
      const cancel = await attempt(() => AppointmentService.cancelAppointment(c1.id, UserRole.CUSTOMER, a1, "verify:referral"));
      const r2 = await reward(c1.welcomeId);
      check(
        "salon: customer cancel → AVAILABLE again (restoreOnCancel), detached",
        cancel.ok && r2?.status === "AVAILABLE" && r2.appointmentId === null && r2.discountMinor === 0,
        cancel.ok ? `${r2?.status}` : said(cancel),
      );
      const b2 = await book(c1.id, (await slot(w, nextDay())).id);
      const a2 = b2.ok ? b2.value.id : "";
      const r3 = await reward(c1.welcomeId);
      check("salon: rebook → RESERVED on the new booking", r3?.status === "RESERVED" && r3.appointmentId === a2, b2.ok ? `${r3?.status}` : said(b2));

      if (a2) {
        await timeTravel(a2, -10);
        const open = await prisma.appointment.findUniqueOrThrow({ where: { id: a2 }, include: { payment: true } });
        const due = paymentSummary(open).amountDueMinor;
        check("salon: counter amountDue = billable − promo (৳1,900)", due === PRICE - 10000, `${due}`);
        const tooMuch = await attempt(() =>
          AppointmentCheckout.checkout(w.ownerActor, a2, { paymentMethod: "CASH", discountMinor: PRICE - 10000 + 100, discountReason: "verify" }),
        );
        check("salon: counter discount capped at bill − promo", !tooMuch.ok && tooMuch.status === 400, said(tooMuch));
      }
      const done = a2 ? await complete(a2) : null;
      const r4 = await reward(c1.welcomeId);
      const ref1 = await referralOf(c1.id);
      const bonus = await prisma.referralReward.findFirst({ where: { referralId: c1.referralId, kind: "REFERRER_BONUS" } });
      check("salon: complete → REDEEMED", !!done?.ok && r4?.status === "REDEEMED" && !!r4.redeemedAt && r4.appointmentId === a2, done ? said(done) : "not booked");
      check(
        "salon: first completion qualifies → referrer reward AVAILABLE (10% · ৳500 cap · SALON · any booking · 90 d)",
        ref1?.status === "QUALIFIED" &&
          ref1.qualifyingAppointmentId === a2 &&
          bonus?.status === "AVAILABLE" &&
          bonus.userId === R1.id &&
          bonus.percentBps === 1000 &&
          bonus.maxDiscountMinor === 50000 &&
          bonus.scope === "SALON" &&
          !bonus.firstBookingOnly &&
          Math.abs(bonus.expiresAt.getTime() - Date.now() - 90 * DAY) < 5 * MIN,
        `${ref1?.status}, bonus ${bonus?.status} ${bonus?.percentBps} bps ${bonus?.scope}`,
      );
      if (done?.ok) completedSalon.push(a2);

      // The first-booking rule: a completion without the welcome lapses it.
      const c2 = await joinedReferee("salon-2", R2);
      const nb = await book(c2.id, (await slot(w, nextDay())).id, null);
      const nbAppt = nb.ok ? await prisma.appointment.findUnique({ where: { id: nb.value.id } }) : null;
      const before2 = await reward(c2.welcomeId);
      check("salon: booking with the reward switched off → no promo, reward untouched", nb.ok && nbAppt?.promoDiscountMinor === 0 && before2?.status === "AVAILABLE", said(nb));
      const nbDone = nb.ok ? await complete(nb.value.id) : null;
      const after2 = await reward(c2.welcomeId);
      check(
        "salon: first booking completed without it → welcome EXPIRED (FIRST_BOOKING_DONE)",
        !!nbDone?.ok && after2?.status === "EXPIRED" && after2.expiredReason === "FIRST_BOOKING_DONE",
        `${after2?.status} ${after2?.expiredReason ?? ""}`,
      );
      if (nbDone?.ok && nb.ok) completedSalon.push(nb.value.id);
      const q2 = await quoteSalon(c2.id, (await slot(w, nextDay())).id);
      check("salon: … and is no longer offered", q2.ok && q2.value.promo === null && q2.value.rewardOptions.length === 0, q2.ok ? `${q2.value.rewardOptions.length} option(s)` : said(q2));

      // No-show uses it up; an upheld appeal gives it back.
      const c3 = await joinedReferee("salon-3", R3);
      const ns = await book(c3.id, (await slot(w, nextDay())).id);
      if (ns.ok) {
        await timeTravel(ns.value.id, -90);
        const mark = await attempt(() => AppointmentService.updateAppointmentStatus(w.owner.id, UserRole.SALON_OWNER, ns.value.id, { status: "NO_SHOW" }));
        const used = await reward(c3.welcomeId);
        check("salon: no-show → REDEEMED (consumed, restoreOnNoShow off)", mark.ok && used?.status === "REDEEMED", mark.ok ? `${used?.status}` : said(mark));
        const consumedEv = await prisma.referralEvent.count({ where: { rewardId: c3.welcomeId!, type: "consumed_no_show" } });
        check("salon: … with a consumed_no_show event, not a redemption", consumedEv === 1, `${consumedEv}`);
        const appeal = await attempt(() => AppointmentService.resolveAppeal(w.admin.id, ns.value.id, { approve: true, withoutAppeal: true, note: "verify" }));
        const back = await reward(c3.welcomeId);
        check("salon: upheld appeal → AVAILABLE again", appeal.ok && back?.status === "AVAILABLE" && back.appointmentId === null, appeal.ok ? `${back?.status}` : said(appeal));
      } else check("salon: no-show booking made", false, said(ns));

      // restoreOnCancel off: a cancel spends the reservation.
      await setSettings({ "referral.restoreOnCancel": false });
      const c4 = await joinedReferee("salon-4", R3);
      const rc = await book(c4.id, (await slot(w, nextDay())).id);
      const rcCancel = rc.ok ? await attempt(() => AppointmentService.cancelAppointment(c4.id, UserRole.CUSTOMER, rc.value.id, "verify")) : rc;
      const gone = await reward(c4.welcomeId);
      check("salon: restoreOnCancel off → cancel moves it to EXPIRED", rcCancel.ok && gone?.status === "EXPIRED" && gone.appointmentId === null, `${said(rcCancel)} → ${gone?.status}`);
      await setSettings({ "referral.restoreOnCancel": true });

      // Reschedule keeps the reservation (same booking id).
      const c5 = await joinedReferee("salon-5", R3);
      const rs = await book(c5.id, (await slot(w, nextDay())).id);
      const target = await slot(w, nextDay());
      const ownerCtx = { ...systemAuditCtx("cli"), actorUserId: w.owner.id, actorRole: "SALON_OWNER" };
      const moved = rs.ok ? await attempt(() => AppointmentCalendar.rescheduleAppointment(w.ownerActor, ownerCtx, rs.value.id, target.id)) : rs;
      const kept = await reward(c5.welcomeId);
      const movedAppt = rs.ok ? await prisma.appointment.findUnique({ where: { id: rs.value.id }, select: { slotId: true, promoDiscountMinor: true } }) : null;
      check(
        "salon: reschedule → still RESERVED on the same booking, promo kept",
        moved.ok && kept?.status === "RESERVED" && rs.ok && kept.appointmentId === rs.value.id && movedAppt?.slotId === target.id && movedAppt.promoDiscountMinor === 10000,
        `${said(moved)}; ${kept?.status}`,
      );

      // Hand-offs for the access matrix: c3 has an AVAILABLE welcome; c1 used theirs.
      out.access = {
        customer: c3.id,
        otherCustomer: c5.id,
        customerRewardId: c3.welcomeId!,
        used: { userId: c1.id, rewardId: c1.welcomeId! },
        referralId: c1.referralId,
        slotBody: (slotId) => bookingBody(w, slotId),
        freshSlot: async () => (await slot(w, nextDay())).id,
      };
    });

    // =======================================================================
    await section("6. Home lifecycle", async () => {
      const h = await joinedReferee("home-1", R4);
      const startA = await homeStart();
      const q1 = await attempt(() => homeQuote(homeActor(h.id), homeBody(startA) as never));
      const qv = q1.ok ? (q1.value as unknown as Record<string, any>) : null;
      check(
        "home: quote picks the welcome on the subtotal (5% of ৳1,300 = ৳65)",
        !!qv && qv.promo?.rewardId === h.welcomeId && qv.promoDiscountMinor === 6500 && qv.subtotalMinor === HOME_PRICE,
        qv ? `promo ${qv.promoDiscountMinor}, subtotal ${qv.subtotalMinor}` : said(q1),
      );
      check(
        "home: total = subtotal − promo + travel; advance + balance = total",
        !!qv && qv.totalMinor === qv.subtotalMinor - qv.promoDiscountMinor + qv.travelFeeMinor && qv.advanceMinor + qv.balanceMinor === qv.totalMinor,
        qv ? `${qv.subtotalMinor} − ${qv.promoDiscountMinor} + ${qv.travelFeeMinor} = ${qv.totalMinor}; ${qv.advanceMinor} + ${qv.balanceMinor}` : "",
      );
      const create = async (start: Date, q: Record<string, any>) =>
        attempt(() =>
          createBooking(
            homeActor(h.id),
            { ...homeBody(start), quoteHash: q.quoteHash, policyAccepted: true, policyVersion: q.policyVersion } as never,
            randomUUID(),
            "en",
          ),
        );
      const c1 = qv ? await create(startA, qv) : null;
      const id1 = c1?.ok ? (c1.value as { id: string }).id : "";
      const held = await reward(h.welcomeId);
      check("home: create → PENDING_PAYMENT, reward RESERVED on the visit", !!c1?.ok && held?.status === "RESERVED" && held.homeBookingId === id1, c1 ? said(c1) : "no quote");
      if (id1) {
        await prisma.homeBooking.update({ where: { id: id1 }, data: { expiresAt: new Date(Date.now() - MIN) } });
        await expireUnpaidHomeBookings();
        const exp = await prisma.homeBooking.findUnique({ where: { id: id1 }, select: { status: true } });
        const back = await reward(h.welcomeId);
        check("home: unpaid expiry → EXPIRED visit, reward AVAILABLE", exp?.status === "EXPIRED" && back?.status === "AVAILABLE" && back.homeBookingId === null, `${exp?.status}, ${back?.status}`);
      }

      // create → pay → complete
      const startB = await homeStart();
      const q2 = await attempt(() => homeQuote(homeActor(h.id), homeBody(startB) as never));
      const qv2 = q2.ok ? (q2.value as unknown as Record<string, any>) : null;
      const c2 = qv2 ? await create(startB, qv2) : null;
      const id2 = c2?.ok ? (c2.value as { id: string }).id : "";
      if (id2) {
        const row = await prisma.homeBooking.findUniqueOrThrow({ where: { id: id2 } });
        await WalletService.mutate({
          userId: h.id,
          type: WalletTxType.ADJUSTMENT,
          amount: row.advanceMinor,
          description: "verify:referral advance (gateway stand-in)",
          idempotencyKey: `ref-verify-fund:${id2}`,
        });
        const paid = await attempt(() => confirmPaidHomeBooking(id2, 0, { fromGateway: true }));
        const stillHeld = await reward(h.welcomeId);
        check("home: paid → CONFIRMED, reward still RESERVED", paid.ok && paid.value.status === "CONFIRMED" && stillHeld?.status === "RESERVED", said(paid));
        await prisma.homeBooking.update({ where: { id: id2 }, data: { status: HomeBookingStatus.IN_PROGRESS, arrivedAt: new Date() } });
        const fin = await attempt(() => completeJob(w.expertUserId, id2, { balanceMethod: "CASH", collectedMinor: row.balanceMinor }));
        const spent = await reward(h.welcomeId);
        const hRef = await referralOf(h.id);
        check("home: complete → REDEEMED", fin.ok && spent?.status === "REDEEMED" && spent.homeBookingId === id2, said(fin));
        check(
          "home: a first home completion qualifies the referral",
          hRef?.status === "QUALIFIED" && hRef.qualifyingHomeBookingId === id2,
          `${hRef?.status}`,
        );
        if (fin.ok) completedHome.push(id2);
      } else check("home: second visit created", false, c2 ? said(c2) : said(q2));

      // PRICE_CHANGED: a better reward appears between quote and create.
      const h2 = await joinedReferee("home-2", R4);
      const startC = await homeStart();
      const q3 = await attempt(() => homeQuote(homeActor(h2.id), homeBody(startC) as never));
      const qv3 = q3.ok ? (q3.value as unknown as Record<string, any>) : null;
      await grantRow(h2.id, { percentBps: 2000, scope: "ALL" });
      const stale = qv3
        ? await attempt(() =>
            createBooking(homeActor(h2.id), { ...homeBody(startC), quoteHash: qv3.quoteHash, policyAccepted: true, policyVersion: qv3.policyVersion } as never, randomUUID(), "en"),
          )
        : q3;
      const h2w = await reward(h2.welcomeId);
      check(
        "home: promo moved between quote and create → 409 PRICE_CHANGED, nothing reserved",
        !stale.ok && stale.status === 409 && stale.code === "PRICE_CHANGED" && h2w?.status === "AVAILABLE" && (await prisma.homeBooking.count({ where: { customerId: h2.id } })) === 0,
        said(stale),
      );

      // Every endVisitTx outcome (rolled back): a customer no-show uses the reward, every other end gives it back.
      const hc = await person("home-ends");
      const snapshot = policySnapshotOf(await currentPolicy()) as unknown as Prisma.InputJsonValue;
      const events: Array<[string, EndEvent, HomeBookingStatus, RewardStatus]> = [
        ["customer cancel", { kind: "CUSTOMER_CANCEL", now: new Date() }, HomeBookingStatus.CONFIRMED, RewardStatus.AVAILABLE],
        ["customer no-show", { kind: "CUSTOMER_NO_SHOW" }, HomeBookingStatus.ARRIVED, RewardStatus.REDEEMED],
        ["mismatch abort", { kind: "MISMATCH_ABORT" }, HomeBookingStatus.ARRIVED, RewardStatus.AVAILABLE],
        ["salon cancel", { kind: "SALON_CANCEL" }, HomeBookingStatus.CONFIRMED, RewardStatus.AVAILABLE],
        ["expert no-show", { kind: "EXPERT_NO_SHOW" }, HomeBookingStatus.CONFIRMED, RewardStatus.AVAILABLE],
        ["admin cancel (salon at fault)", { kind: "ADMIN_CANCEL", salonAtFault: true }, HomeBookingStatus.CONFIRMED, RewardStatus.AVAILABLE],
        ["admin cancel", { kind: "ADMIN_CANCEL", salonAtFault: false }, HomeBookingStatus.CONFIRMED, RewardStatus.AVAILABLE],
        ["system cancel", { kind: "SYSTEM_CANCEL" }, HomeBookingStatus.CONFIRMED, RewardStatus.AVAILABLE],
        ["safety abort", { kind: "SAFETY_ABORT" }, HomeBookingStatus.ARRIVED, RewardStatus.AVAILABLE],
      ];
      await rolledBack("home ends", async (tx) => {
        await WalletService.mutate(
          { userId: hc.id, type: WalletTxType.ADJUSTMENT, amount: 2_000_000, description: "verify:referral", idempotencyKey: `ref-verify-ends:${TAG}` },
          tx,
        );
        let n = 0;
        for (const [label, event, from, want] of events) {
          n += 1;
          const startAt = new Date(Date.now() + 9 * DAY + n * 3 * HOUR);
          const endAt = new Date(startAt.getTime() + HOUR);
          const b = await tx.homeBooking.create({
            data: {
              code: `HS-R${TAG.slice(0, 4).toUpperCase()}${n}`,
              customerId: hc.id,
              salonId: w.salonId,
              expertId: w.expertId,
              audience: HomeAudience.LADIES,
              expertAudience: HomeAudience.LADIES,
              status: from,
              startAt,
              endAt,
              blockFrom: startAt,
              blockTo: endAt,
              serviceDate: new Date(`${dhakaDay(startAt)}T00:00:00Z`),
              addressLine: "House 1, Road 1",
              latitude: LAT,
              longitude: LNG,
              distanceKm: 0,
              recipientName: "Verify",
              contactPhone: "01711111111",
              subtotalMinor: HOME_PRICE,
              promoDiscountMinor: 6500,
              promoLabel: "Reward (10%)",
              travelFeeMinor: 0,
              totalMinor: HOME_PRICE - 6500,
              advancePercent: 50,
              advanceMinor: 61750,
              balanceMinor: 61750,
              commissionBps: 1000,
              policySnapshot: snapshot,
              disclaimerText: "verify",
              confirmedAt: new Date(Date.now() - HOUR),
              arrivedAt: from === HomeBookingStatus.ARRIVED ? new Date(Date.now() - 30 * MIN) : null,
              isTest: true,
              items: { create: { offeringId: w.offeringId, nameSnapshot: "Verify facial", priceMinor: HOME_PRICE, durationMin: 60 } },
            },
            select: { id: true },
          });
          await WalletService.holdHomeAdvance(hc.id, 61750, b.id, tx);
          await tx.homeBooking.update({ where: { id: b.id }, data: { advanceStatus: AdvanceStatus.HELD } });
          const r = await tx.referralReward.create({
            data: { userId: hc.id, kind: "MANUAL_GRANT", status: "AVAILABLE", percentBps: 500, maxDiscountMinor: 0, scope: "ALL", expiresAt: new Date(Date.now() + 30 * DAY) },
          });
          await reserveTx(tx, { rewardId: r.id, userId: hc.id, homeBookingId: b.id, discountMinor: 6500 });
          let end = "ok";
          try {
            await endVisitTx(tx, { id: b.id, event, from: [from], actorId: null, actorRole: "SYSTEM", reason: "verify:referral" });
          } catch (e) {
            end = errMsg(e);
          }
          const got = await tx.referralReward.findUniqueOrThrow({ where: { id: r.id } });
          check(`home end · ${label} → ${want}`, end === "ok" && got.status === want, `${end}; ${got.status}`);
        }
      });
    });

    // =======================================================================
    await section("8. Qualify + caps", async () => {
      // First completion only: a second completed booking by the same friend issues nothing new.
      const s1 = await prisma.referral.findFirst({ where: { referrerId: R1.id, status: "QUALIFIED", qualifyingAppointmentId: { not: null } } });
      if (s1) {
        const again = await book(s1.refereeId, (await slot(w, nextDay())).id);
        const d = again.ok ? await complete(again.value.id) : again;
        const bonuses = await prisma.referralReward.count({ where: { referralId: s1.id, kind: "REFERRER_BONUS" } });
        const same = await prisma.referral.findUnique({ where: { id: s1.id }, select: { qualifyingAppointmentId: true } });
        check(
          "qualify: a second completion issues no second referrer reward",
          d.ok && bonuses === 1 && same?.qualifyingAppointmentId === s1.qualifyingAppointmentId,
          `${said(d)}; ${bonuses} bonus(es)`,
        );
        if (d.ok && again.ok) completedSalon.push(again.value.id);
      } else check("qualify: section 5 left a qualified referral", false);

      const Rq = await referrer("qualify");
      const notQualified = async (label: string, prep: (tx: Tx, f: { id: string; referralId: string }) => Promise<void>, o: Parameters<typeof settleIn>[2] = {}) => {
        const f = await joinedReferee(`q-${label.replace(/\W+/g, "-")}`, Rq, { welcome: false });
        await rolledBack(label, async (tx) => {
          await prep(tx, f);
          await settleIn(tx, f.id, o);
          const r = await tx.referral.findUniqueOrThrow({ where: { id: f.referralId } });
          const n = await tx.referralReward.count({ where: { referralId: f.referralId, kind: "REFERRER_BONUS" } });
          check(`qualify: not on ${label}`, r.status === "JOINED" && n === 0, `${r.status}, ${n} bonus`);
        });
      };
      await notQualified("a SALON_DIRECT booking", async () => undefined, { source: AppointmentSource.SALON_DIRECT });
      await setSettings({ "referral.minOrderMinor": PRICE + 100 });
      await notQualified("a booking below minOrderMinor", async () => undefined);
      await setSettings({ "referral.minOrderMinor": 0 });
      await notQualified("a booking outside qualifyWindowDays (joined 61 d ago)", async (tx, f) => {
        await tx.referral.update({ where: { id: f.referralId }, data: { joinedAt: new Date(Date.now() - 61 * DAY) } });
      });
      const inWindow = await joinedReferee("q-in-window", Rq, { welcome: false, joinedAgoMs: 59 * DAY });
      await rolledBack("in window", async (tx) => {
        await settleIn(tx, inWindow.id);
        const r = await tx.referral.findUniqueOrThrow({ where: { id: inWindow.referralId } });
        check("qualify: joined 59 d ago → QUALIFIED (control)", r.status === "QUALIFIED", r.status);
      });

      // Held for review, then approved / rejected by an admin.
      const Rh = await referrer("hold");
      const held1 = await joinedReferee("hold-approve", Rh, { flags: ["SAME_DEVICE"], welcome: false });
      const held2 = await joinedReferee("hold-reject", Rh, { flags: ["SAME_NETWORK"], welcome: false });
      for (const f of [held1, held2]) {
        const id = await prisma.$transaction((tx) => settleIn(tx, f.id), { timeout: 30_000 });
        completedSalon.push(id);
      }
      const b1 = await prisma.referralReward.findFirst({ where: { referralId: held1.referralId, kind: "REFERRER_BONUS" } });
      const b2 = await prisma.referralReward.findFirst({ where: { referralId: held2.referralId, kind: "REFERRER_BONUS" } });
      check("qualify: flagged referral → referrer reward PENDING_REVIEW (holdFlagged)", b1?.status === "PENDING_REVIEW" && b2?.status === "PENDING_REVIEW", `${b1?.status}, ${b2?.status}`);
      const ap = await attempt(() => approveReferral(w.adminCtx, held1.referralId, "verify:referral"));
      const b1a = await reward(b1?.id);
      check("qualify: approve → AVAILABLE", ap.ok && b1a?.status === "AVAILABLE", `${said(ap)}; ${b1a?.status}`);
      const rj = await attempt(() => rejectReferral(w.adminCtx, held2.referralId, "verify:referral reject"));
      const b2a = await reward(b2?.id);
      const r2a = await prisma.referral.findUnique({ where: { id: held2.referralId }, select: { status: true } });
      check("qualify: reject → reward REVOKED, referral REJECTED", rj.ok && b2a?.status === "REVOKED" && r2a?.status === "REJECTED", `${said(rj)}; ${b2a?.status}, ${r2a?.status}`);

      // Caps.
      const capRun = async (label: string, settings: Record<string, number>, want: string[]) => {
        const Rc = await referrer(`cap-${label}`);
        const friends: Array<Awaited<ReturnType<typeof joinedReferee>>> = [];
        for (let i = 0; i < want.length; i++) friends.push(await joinedReferee(`cap-${label}-${i}`, Rc, { welcome: false }));
        await setSettings(settings);
        await rolledBack(`cap ${label}`, async (tx) => {
          const got: string[] = [];
          for (const f of friends) {
            await settleIn(tx, f.id);
            const r = await tx.referral.findUniqueOrThrow({ where: { id: f.referralId } });
            const b = await tx.referralReward.findFirst({ where: { referralId: f.referralId, kind: "REFERRER_BONUS" } });
            got.push(b ? b.status : `${r.status}:${r.referrerRewardSkip}`);
          }
          check(`caps: ${label} → ${want.join(", ")}`, JSON.stringify(got) === JSON.stringify(want), got.join(", "));
        });
        await setSettings({ "referral.maxRewardsPerMonth": 10, "referral.maxRewardsLifetime": 50 });
      };
      await capRun("month", { "referral.maxRewardsPerMonth": 2, "referral.maxRewardsLifetime": 0 }, ["AVAILABLE", "AVAILABLE", "QUALIFIED:CAP_MONTH"]);
      await capRun("lifetime", { "referral.maxRewardsPerMonth": 0, "referral.maxRewardsLifetime": 2 }, ["AVAILABLE", "AVAILABLE", "QUALIFIED:CAP_LIFETIME"]);

      // REFEREE_VERIFIED trigger: the referrer's reward comes at verification.
      await setSettings({ "referral.referrerTrigger": "REFEREE_VERIFIED" });
      const Rt = await referrer("trigger");
      const tf = await person("trigger-friend", UserRole.CUSTOMER, { emailVerified: false, emailVerifiedAt: null });
      const tRef = await prisma.referral.create({ data: { referrerId: Rt.id, refereeId: tf.id, code: Rt.code, channel: "CODE", isTest: true } });
      await prisma.user.update({ where: { id: tf.id }, data: { emailVerified: true, emailVerifiedAt: new Date() } });
      await onEmailVerified(tf.id);
      const tAfter = await prisma.referral.findUnique({ where: { id: tRef.id }, include: { rewards: true } });
      check(
        "qualify: referrerTrigger REFEREE_VERIFIED → QUALIFIED + referrer reward at verification",
        tAfter?.status === "QUALIFIED" && tAfter.rewards.some((r) => r.kind === "REFERRER_BONUS" && r.status === "AVAILABLE") && tAfter.rewards.some((r) => r.kind === "REFEREE_WELCOME"),
        `${tAfter?.status}; ${tAfter?.rewards.map((r) => `${r.kind}:${r.status}`).join(", ")}`,
      );
      await setSettings({ "referral.referrerTrigger": "FIRST_BOOKING_COMPLETED" });

      // Snapshots: a settings change never rewrites an issued reward.
      const r1Bonus = await prisma.referralReward.findFirst({ where: { userId: R1.id, kind: "REFERRER_BONUS", status: "AVAILABLE" } });
      await setSettings({ "referral.referrerPercent": 20 });
      const r1After = await reward(r1Bonus?.id);
      const r1Quote = await quoteSalon(R1.id, (await slot(w, nextDay())).id);
      check(
        "snapshot: referrerPercent 10 → 20 after issue; the reward keeps 1000 bps and quotes ৳200",
        !!r1Bonus && r1After?.percentBps === 1000 && r1Quote.ok && r1Quote.value.promo?.rewardId === r1Bonus.id && r1Quote.value.promo.discountMinor === rewardDiscountMinor(PRICE, 1000, 50000),
        r1Quote.ok ? `${r1After?.percentBps} bps, promo ${r1Quote.value.promo?.discountMinor}` : said(r1Quote),
      );
      await setSettings({ "referral.referrerPercent": 10 });
    });

    // =======================================================================
    await section("9. Jobs", async () => {
      const j = await person("jobs");
      const lapsed = await grantRow(j.id, { expiresInMs: -HOUR });
      const lapsedHeld = await grantRow(j.id, { expiresInMs: -HOUR, status: RewardStatus.PENDING_REVIEW });
      const live = await grantRow(j.id, { expiresInMs: 10 * DAY });
      const Rj = await referrer("jobs-ref");
      const stale = await joinedReferee("jobs-stale", Rj, { welcome: false, joinedAgoMs: 61 * DAY });
      const ex = await runReferralExpire();
      const [l1, l2, l3] = await Promise.all([reward(lapsed.id), reward(lapsedHeld.id), reward(live.id)]);
      const staleRef = await prisma.referral.findUnique({ where: { id: stale.referralId }, select: { status: true } });
      check(
        "jobs: referral.expire → past-expiry AVAILABLE and PENDING_REVIEW → EXPIRED (TIME), live one kept",
        l1?.status === "EXPIRED" && l1.expiredReason === "TIME" && l2?.status === "EXPIRED" && l3?.status === "AVAILABLE",
        `${l1?.status}, ${l2?.status}, ${l3?.status} (${JSON.stringify(ex)})`,
      );
      check("jobs: referral.expire → JOINED past qualifyWindowDays → EXPIRED", staleRef?.status === "EXPIRED", `${staleRef?.status}`);

      // Reminders: once, claimed through remindedAt.
      const KEY = "referral.reminders.day";
      const savedState = await prisma.alertState.findUnique({ where: { key: KEY } });
      const due = await grantRow(j.id, { expiresInMs: 2 * DAY });
      const real = new Date();
      const dhakaHour = (real.getUTCHours() + 6) % 24;
      const at = dhakaHour >= 10 ? real : new Date(`${dhakaDay(real)}T04:30:00.000Z`); // 10:30 Dhaka today
      try {
        await prisma.alertState.deleteMany({ where: { key: KEY } });
        const run1 = await runReferralReminders(at);
        const first = await reward(due.id);
        check("jobs: referral.reminders → reminds a reward running out within 3 days", run1.ran === true && !!first?.remindedAt, JSON.stringify(run1));
        const run2 = await runReferralReminders(at);
        check("jobs: referral.reminders → a second run the same day does nothing", run2.ran === false, JSON.stringify(run2));
        await prisma.alertState.deleteMany({ where: { key: KEY } });
        const run3 = await runReferralReminders(at);
        const third = await reward(due.id);
        check(
          "jobs: referral.reminders → never twice for one reward (remindedAt)",
          run3.ran === true && third?.remindedAt?.getTime() === first?.remindedAt?.getTime(),
          JSON.stringify(run3),
        );
      } finally {
        await prisma.alertState.deleteMany({ where: { key: KEY } });
        if (savedState) {
          const { key, ...rest } = savedState;
          await prisma.alertState.create({ data: { key, ...rest, detail: rest.detail ?? Prisma.JsonNull } as never });
        }
      }

      // Reconcile: an orphaned RESERVED, and a redemption with no ledger line.
      const { date } = wallClock(new Date(Date.now() + 3 * DAY));
      const mk = (status: AppointmentStatus) =>
        prisma.appointment.create({
          data: {
            customerId: j.id,
            salonId: w.salonId,
            serviceId: w.serviceId,
            counterId: w.counterId,
            appointmentDate: date,
            startTime: "10:00",
            endTime: "11:00",
            status,
            source: AppointmentSource.PLATFORM,
            totalMinor: PRICE,
            depositMinor: 0,
            commissionBps: 1000,
            ...(status === AppointmentStatus.COMPLETED ? { completedAt: new Date(), completedById: w.owner.id } : { cancelledAt: new Date() }),
          },
        });
      const cancelled = await mk(AppointmentStatus.CANCELLED);
      const orphan = await prisma.referralReward.create({
        data: { userId: j.id, kind: "MANUAL_GRANT", status: "RESERVED", percentBps: 500, maxDiscountMinor: 0, scope: "ALL", expiresAt: new Date(Date.now() + 30 * DAY), appointmentId: cancelled.id, discountMinor: 10000, reservedAt: new Date() },
      });
      const completedNoLine = await mk(AppointmentStatus.COMPLETED);
      const noLine = await prisma.referralReward.create({
        data: { userId: j.id, kind: "MANUAL_GRANT", status: "REDEEMED", percentBps: 500, maxDiscountMinor: 0, scope: "ALL", expiresAt: new Date(Date.now() + 30 * DAY), appointmentId: completedNoLine.id, discountMinor: 10000, reservedAt: new Date(), redeemedAt: new Date() },
      });
      const rec = await runReferralReconcile();
      const fixed = await reward(orphan.id);
      check(
        "jobs: referral.reconcile → orphaned RESERVED on a cancelled booking → AVAILABLE",
        fixed?.status === "AVAILABLE" && fixed.appointmentId === null && (rec.fixedBy.release ?? 0) >= 1,
        `${fixed?.status}; fixed ${JSON.stringify(rec.fixedBy)}`,
      );
      check(
        "jobs: referral.reconcile → reports the redemption with no PLATFORM_PROMO line",
        rec.redeemedMismatch >= 1 && rec.mismatchRewardIds.includes(noLine.id),
        `${rec.redeemedMismatch} mismatch(es)`,
      );
      // Gone at once, so the mismatch alert doesn't outlive the check.
      await prisma.referralReward.delete({ where: { id: noLine.id } });
      await prisma.appointment.delete({ where: { id: completedNoLine.id } });
    });

    // =======================================================================
    await section("10. Kill switches", async () => {
      const k1 = await joinedReferee("kill-issued", R5);
      await setSettings({ "referral.enabled": false });
      const off = await signUp("kill-signup", R5.code);
      check("kill: enabled off → attach refused (REFERRAL_PROGRAM_OFF), no user", !off.res.ok && off.res.code === "REFERRAL_PROGRAM_OFF" && (await userCount(off.email)) === 0, said(off.res));
      const usable = await book(k1.id, (await slot(w, nextDay())).id);
      const k1r = await reward(k1.welcomeId);
      check("kill: enabled off → an issued reward is still usable", usable.ok && k1r?.status === "RESERVED", said(usable));
      const late = await person("kill-late-verify", UserRole.CUSTOMER, { emailVerified: false, emailVerifiedAt: null });
      await prisma.referral.create({ data: { referrerId: R5.id, refereeId: late.id, code: R5.code, channel: "CODE", isTest: true } });
      await prisma.user.update({ where: { id: late.id }, data: { emailVerified: true, emailVerifiedAt: new Date() } });
      await onEmailVerified(late.id);
      const lateRef = await referralOf(late.id);
      check(
        "kill: enabled off → a referral attached while on still gets its welcome at verification",
        lateRef?.status === "JOINED" && lateRef.rewards.some((r) => r.kind === "REFEREE_WELCOME" && r.status === "AVAILABLE"),
        `${lateRef?.status}, ${lateRef?.rewards.length} reward(s)`,
      );
      await setSettings({ "referral.enabled": true });

      const k2 = await joinedReferee("kill-reserved", R5);
      const k3 = await joinedReferee("kill-quote", R5);
      const reserved = await book(k2.id, (await slot(w, nextDay())).id);
      await setSettings({ "referral.redemptionsEnabled": false });
      try {
        const qOff = await quoteSalon(k3.id, (await slot(w, nextDay())).id);
        check("kill: redemptions off → quote shows no reward", qOff.ok && qOff.value.promo === null && qOff.value.rewardOptions.length === 0, qOff.ok ? `${qOff.value.rewardOptions.length} option(s)` : said(qOff));
        const ask = await quoteSalon(k3.id, (await slot(w, nextDay())).id, k3.welcomeId);
        check("kill: redemptions off → asking for one → 400 REWARD_NOT_APPLICABLE (REDEMPTIONS_OFF)", !ask.ok && ask.status === 400 && ask.details?.reason === "REDEMPTIONS_OFF", said(ask));
        const fin = reserved.ok ? await complete(reserved.value.id) : reserved;
        const k2r = await reward(k2.welcomeId);
        const promoLines = reserved.ok ? await prisma.ledgerEntry.findMany({ where: { appointmentId: reserved.value.id, account: LedgerAccount.PLATFORM_PROMO } }) : [];
        check(
          "kill: redemptions off → an already-reserved booking completes with its promo",
          fin.ok && k2r?.status === "REDEEMED" && sum(promoLines) === -10000,
          `${said(fin)}; ${k2r?.status}, promo lines ${sum(promoLines)}`,
        );
        if (fin.ok && reserved.ok) completedSalon.push(reserved.value.id);
      } finally {
        await setSettings({ "referral.redemptionsEnabled": true });
      }
    });

    // =======================================================================
    await section("7. Money (every completed fixture)", async () => {
      let promoTotal = 0;
      for (const id of completedSalon) {
        const a = await prisma.appointment.findUniqueOrThrow({ where: { id }, include: { payment: true } });
        const lines = await prisma.ledgerEntry.findMany({ where: { appointmentId: id } });
        const journals = new Map<string, number>();
        for (const l of lines) journals.set(l.journalId, (journals.get(l.journalId) ?? 0) + l.amountMinor);
        const promo = a.promoDiscountMinor;
        promoTotal += promo;
        const promoLines = lines.filter((l) => l.account === LedgerAccount.PLATFORM_PROMO);
        const salonPromo = lines.filter((l) => l.account === LedgerAccount.SALON_PAYABLE && l.description === PROMO_SALON_DESCRIPTION);
        const commission = sum(lines.filter((l) => l.account === LedgerAccount.PLATFORM_REVENUE));
        const fullCommission = resolveCommissionMinor(billableMinor(a), a.commissionBps ?? undefined);
        const label = `money · salon ${id.slice(0, 8)} (promo ৳${promo / 100})`;
        check(
          `${label}: every journal sums to 0`,
          lines.length > 0 && [...journals.values()].every((v) => v === 0),
          `${lines.length} line(s), ${journals.size} journal(s)`,
        );
        check(
          `${label}: PLATFORM_PROMO = −promo, SALON_PAYABLE +promo`,
          promo === 0
            ? promoLines.length === 0 && salonPromo.length === 0
            : sum(promoLines) === -promo && promoLines.every((l) => l.description === PROMO_PLATFORM_DESCRIPTION) && sum(salonPromo) === promo,
          `promo lines ${sum(promoLines)}, salon promo ${sum(salonPromo)}`,
        );
        check(`${label}: commission on the full billable amount`, commission === fullCommission, `${commission} vs ${fullCommission}`);
        if (a.payment) {
          check(
            `${label}: counter took billable − promo`,
            a.payment.amountMinor === billableMinor(a) - promo && paymentSummary(a).amountDueMinor === 0,
            `${a.payment.amountMinor}`,
          );
        }
      }
      for (const id of completedHome) {
        const h = await prisma.homeBooking.findUniqueOrThrow({ where: { id } });
        const lines = await prisma.ledgerEntry.findMany({ where: { homeBookingId: id } });
        const promo = h.promoDiscountMinor;
        promoTotal += promo;
        const commission = sum(lines.filter((l) => l.account === LedgerAccount.PLATFORM_REVENUE));
        const label = `money · home ${h.code} (promo ৳${promo / 100})`;
        check(`${label}: journal sums to 0`, lines.length > 0 && sum(lines) === 0, `${lines.length} line(s)`);
        check(
          `${label}: PLATFORM_PROMO = −promo, SALON_PAYABLE +promo`,
          sum(lines.filter((l) => l.account === LedgerAccount.PLATFORM_PROMO)) === -promo &&
            sum(lines.filter((l) => l.account === LedgerAccount.SALON_PAYABLE && l.description === PROMO_SALON_DESCRIPTION)) === promo,
          "",
        );
        check(`${label}: commission on the full subtotal`, commission === homeCommissionMinor(h.subtotalMinor, h.commissionBps) && commission > 0, `${commission}`);
        check(
          `${label}: total = subtotal − promo + travel, advance + balance = total`,
          h.totalMinor === h.subtotalMinor - promo + h.travelFeeMinor && h.advanceMinor + h.balanceMinor === h.totalMinor,
          `${h.subtotalMinor} − ${promo} + ${h.travelFeeMinor} = ${h.totalMinor}`,
        );
      }
      check("money: at least one salon and one home completion carried a promo", promoTotal > 0 && completedHome.length > 0 && completedSalon.length > 0, `${promoTotal}`);
      const earnings = await getPlatformEarnings({ from: runStart, to: new Date(), includeTest: true });
      check("money: getPlatformEarnings.promoCostMinor = the fixtures' promo", earnings.promoCostMinor === promoTotal, `${earnings.promoCostMinor} vs ${promoTotal}`);
      check(
        "money: netRevenueMinor = commission − promo cost",
        earnings.netRevenueMinor === earnings.platformRevenueMinor - earnings.promoCostMinor,
        `${earnings.netRevenueMinor}`,
      );
    });
  } finally {
    console.log = realLog;
    Object.assign(config.auth, authBefore);
    config.google.signupRequiresOtp = googleOtpBefore;
  }
  return out;
};
