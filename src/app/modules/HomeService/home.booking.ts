import { createHash, randomInt } from "crypto";
import {
  AdvanceStatus,
  BookingPause,
  ExpertVerification,
  HomeAudience,
  HomeBookingStatus,
  Prisma,
  SalonStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { grantAt } from "../../utils/salonAccess";
import { getSetting } from "../../utils/settings";
import { dayStart, dhakaDay } from "../Analytics/analytics.days";
import { PaymentIntentService } from "../Payment/paymentIntent.service";
import type { ProviderName } from "../Payment/providers/types";
import { SALON_GEOG } from "../Salon/salon.geo";
import { BD_BOUNDS } from "../Salon/salon.validation";
import { lockStaff } from "../Staff/staff.schedule";
import { WalletService } from "../Wallet/wallet.service";
import { availableFor, eligibleExperts, expertCanTake, loadCart, loadSlotSettings, windowDays } from "./home.availability";
import { ACTIVE_BOOKING_STATUSES } from "./home.expertSetup";
import { startCodeFor } from "./home.lifecycle";
import { priceCart } from "./home.money";
import { homeNotice } from "./home.notify";
import { isBranchBookable, loadHomeFlags } from "./home.owner";
import {
  buildDisclaimer,
  currentPolicy,
  DisclaimerLang,
  disclaimersOf,
  policySnapshotOf,
  requiresAcceptance,
} from "./home.policy";
import type { CreateBookingBody, QuoteBody } from "./home.validation";

/**
 * Booking a home visit: quote → create (PENDING_PAYMENT, the slot is held)
 * → pay the advance (a wallet hold, topped up at a gateway when short) →
 * CONFIRMED. The quote and the create run the same checks in the same order;
 * the create repeats the slot check under the stylist lock that salon
 * bookings take too (`lockStaff`), and the overlap exclusion on
 * home_bookings backs it up.
 */

type Tx = Prisma.TransactionClient;
export type Actor = { userId: string; impersonating?: boolean };

const MAX_VISIT_MIN = 8 * 60;
const PAGE_SIZE = 10;
const MIN_MS = 60 * 1000;
const BD_MOBILE = /^01[3-9]\d{8}$/;
const URL_LIKE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|bd|io|xyz|me|info|link|ly|co|app|site)\b)/i;

const fail = (status: number, message: string, code: string, details?: Record<string, unknown>) =>
  ApiError.withCode(status, message, code, details);

/** "+880 1712-345678" → "01712345678", or null. */
const bdMobile = (raw: string | null | undefined) => {
  const digits = (raw ?? "").replace(/[\s-]/g, "").replace(/^\+?88(?=01)/, "");
  return BD_MOBILE.test(digits) ? digits : null;
};

/** Unpaid bookings past their window are dead whether or not the job has swept them yet. */
const liveNow = (now: Date): Prisma.HomeBookingWhereInput => ({
  OR: [{ status: { not: HomeBookingStatus.PENDING_PAYMENT } }, { expiresAt: null }, { expiresAt: { gt: now } }],
});

// ---------------------------------------------------------------------------
// 1. Who
// ---------------------------------------------------------------------------

/** PENDING_PAYMENT elsewhere and the active cap. Run again under the customer lock at create. */
const assertCustomerFree = async (userId: string, now: Date, db: Tx | typeof prisma = prisma) => {
  const pending = await db.homeBooking.findFirst({
    where: { customerId: userId, status: HomeBookingStatus.PENDING_PAYMENT, expiresAt: { gt: now } },
    select: { id: true, code: true },
  });
  if (pending) {
    throw fail(StatusCodes.CONFLICT, `Finish paying for ${pending.code} first, or let it lapse.`, "PAYMENT_PENDING_EXISTS", {
      bookingId: pending.id,
    });
  }
  const [active, max] = [
    await db.homeBooking.count({ where: { customerId: userId, status: { in: ACTIVE_BOOKING_STATUSES }, ...liveNow(now) } }),
    await getSetting("homeService.maxActivePerCustomer"),
  ];
  if (active >= max) {
    throw fail(StatusCodes.CONFLICT, `You can have up to ${max} upcoming home visits at a time.`, "TOO_MANY_ACTIVE");
  }
};

const checkWho = async (actor: Actor, salonId: string, now: Date) => {
  const user = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { id: true, role: true, status: true, emailVerified: true, phone: true, isDeleted: true, isTest: true },
  });
  if (!user || user.isDeleted) throw new ApiError(StatusCodes.NOT_FOUND, "User not found");
  if (user.role !== UserRole.CUSTOMER) {
    throw fail(
      StatusCodes.FORBIDDEN,
      "Only customer accounts can book a home visit. Sign in with a customer account to book.",
      "HOME_SERVICE_CUSTOMER_ONLY",
    );
  }
  if (user.status !== UserStatus.ACTIVE) {
    throw fail(StatusCodes.FORBIDDEN, "Your account can't book right now.", "ACCOUNT_NOT_ACTIVE");
  }
  if (!user.emailVerified) {
    throw fail(StatusCodes.FORBIDDEN, "Verify your email address before booking a home visit.", "ACCOUNT_NOT_ACTIVE");
  }
  if (actor.impersonating) {
    throw fail(StatusCodes.FORBIDDEN, "Read-only view: changes are not allowed while viewing as this user.", "IMPERSONATION_READ_ONLY");
  }
  if (!bdMobile(user.phone)) {
    throw fail(StatusCodes.BAD_REQUEST, "Add a Bangladeshi mobile number to your profile to book a home visit.", "PHONE_REQUIRED");
  }

  const [grant, staff] = await Promise.all([
    grantAt({ userId: user.id, role: user.role }, salonId),
    prisma.staff.findFirst({ where: { userId: user.id, salonId, isDeleted: false }, select: { id: true } }),
  ]);
  if (grant || staff) throw fail(StatusCodes.FORBIDDEN, "You can't book a home visit from your own salon.", "OWN_SALON");

  await assertCustomerFree(user.id, now);

  const block = await prisma.homeCustomerBlock.findUnique({ where: { userId: user.id }, select: { until: true } });
  if (block && block.until > now) {
    throw fail(StatusCodes.FORBIDDEN, "Home visits are paused on your account for now.", "HOME_SERVICE_BLOCKED", {
      until: block.until,
    });
  }
  return user;
};

// ---------------------------------------------------------------------------
// The full check (quote and create)
// ---------------------------------------------------------------------------

const quoteHashOf = (parts: {
  price: Record<string, number>;
  policyVersion: number;
  startAt: Date;
  expertId: string;
  offeringIds: string[];
}) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        price: parts.price,
        policyVersion: parts.policyVersion,
        startAt: parts.startAt.toISOString(),
        expertId: parts.expertId,
        offeringIds: [...parts.offeringIds].sort(),
      }),
    )
    .digest("hex");

const runChecks = async (actor: Actor, body: QuoteBody) => {
  const now = new Date();

  // 1. Who
  const customer = await checkWho(actor, body.salonId, now);

  // 2. What
  const cart = await loadCart(body.offeringIds);
  if (cart.salonId !== body.salonId) {
    throw fail(StatusCodes.BAD_REQUEST, "These services are from another salon.", "INVALID_CART");
  }
  if (cart.audience !== body.audience) {
    throw fail(StatusCodes.BAD_REQUEST, "These services are for the other side.", "INVALID_CART");
  }
  const [flags, profile] = await Promise.all([
    loadHomeFlags(),
    prisma.homeServiceProfile.findUnique({
      where: { salonId: cart.salonId },
      include: { salon: { select: { id: true, name: true, status: true, isDeleted: true, bookingPause: true, isTest: true } } },
    }),
  ]);
  if (!profile) throw fail(StatusCodes.NOT_FOUND, "Home service isn't available here right now.", "HOME_SERVICE_UNAVAILABLE");
  const salon = profile.salon;
  if (salon.isDeleted || salon.status !== SalonStatus.ACTIVE || salon.bookingPause !== BookingPause.NONE) {
    throw fail(StatusCodes.CONFLICT, "This salon isn't taking bookings right now.", "SALON_UNAVAILABLE");
  }
  if ((salon.isTest && !customer.isTest) || !isBranchBookable(profile, salon, cart.audience, flags, now)) {
    throw fail(StatusCodes.NOT_FOUND, "Home service isn't available here right now.", "HOME_SERVICE_UNAVAILABLE");
  }
  if (cart.subtotalMinor < profile.minOrderMinor) {
    throw fail(StatusCodes.BAD_REQUEST, "Add a little more to reach this salon's minimum order.", "BELOW_MIN_ORDER", {
      minOrderMinor: profile.minOrderMinor,
    });
  }
  if (cart.durationMin > MAX_VISIT_MIN) {
    throw fail(StatusCodes.BAD_REQUEST, "One visit can't be longer than 8 hours. Split it into two.", "VISIT_TOO_LONG");
  }

  // 3. Expert
  const specific = body.expertId === "ANY" ? null : body.expertId;
  let expert: Awaited<ReturnType<typeof loadExpertCard>> = null;
  if (specific) {
    const e = await prisma.homeExpert.findUnique({
      where: { id: specific },
      select: {
        salonId: true,
        audience: true,
        verification: true,
        isActive: true,
        removedAt: true,
        staff: { select: { isDeleted: true } },
        offerings: { select: { offeringId: true } },
      },
    });
    if (
      !e ||
      e.salonId !== cart.salonId ||
      e.verification !== ExpertVerification.VERIFIED ||
      !e.isActive ||
      e.removedAt ||
      e.staff.isDeleted
    ) {
      throw fail(StatusCodes.NOT_FOUND, "This expert isn't available.", "EXPERT_UNAVAILABLE");
    }
    if (e.audience !== cart.audience) {
      throw fail(
        StatusCodes.BAD_REQUEST,
        cart.audience === HomeAudience.LADIES
          ? "Ladies at Home visits are done by women experts only."
          : "Gents at Home visits are done by men experts only.",
        "EXPERT_GENDER_MISMATCH",
      );
    }
    const linked = new Set(e.offerings.map((o) => o.offeringId));
    if (!cart.items.every((i) => linked.has(i.id))) {
      throw fail(StatusCodes.CONFLICT, "This expert doesn't do every service in your cart.", "EXPERT_CANNOT_DO_SERVICE");
    }
    expert = await loadExpertCard(specific);
  } else {
    const any = await eligibleExperts({ salonId: cart.salonId, audience: cart.audience, offeringIds: cart.items.map((i) => i.id) });
    if (!any.length) throw fail(StatusCodes.CONFLICT, "No expert here does all of these services.", "NO_EXPERT_FREE");
  }

  // 4. When
  const startAt = new Date(body.startAt);
  if (Number.isNaN(startAt.getTime()) || dhakaDay(startAt) !== body.date) {
    throw fail(StatusCodes.BAD_REQUEST, "That time isn't valid.", "INVALID_TIME");
  }
  const slotSettings = await loadSlotSettings();
  if (!windowDays(slotSettings, now).includes(body.date)) {
    throw fail(
      StatusCodes.BAD_REQUEST,
      `Pick a day within the next ${slotSettings.bookingWindowDays} days.`,
      "OUTSIDE_BOOKING_WINDOW",
    );
  }
  if (startAt.getTime() < now.getTime() + slotSettings.minLeadMin * MIN_MS) {
    throw fail(StatusCodes.BAD_REQUEST, `Book at least ${slotSettings.minLeadMin} minutes ahead.`, "TOO_SOON");
  }
  if ((startAt.getTime() - dayStart(body.date).getTime()) % (slotSettings.stepMin * MIN_MS) !== 0) {
    throw fail(StatusCodes.BAD_REQUEST, "That time isn't on the booking grid.", "INVALID_TIME");
  }
  const { byDay } = await availableFor({ expertId: specific ?? undefined, offeringIds: body.offeringIds, days: [body.date], now });
  const slot = (byDay.get(body.date) ?? []).find((s) => s.startAt.getTime() === startAt.getTime());
  if (!slot) {
    throw specific
      ? fail(StatusCodes.CONFLICT, "This time was just taken. Pick another.", "SLOT_TAKEN")
      : fail(StatusCodes.CONFLICT, "No expert is free at that time. Pick another.", "NO_EXPERT_FREE");
  }

  // 5. Where
  if (
    !Number.isFinite(body.lat) ||
    !Number.isFinite(body.lng) ||
    body.lat < BD_BOUNDS.minLat ||
    body.lat > BD_BOUNDS.maxLat ||
    body.lng < BD_BOUNDS.minLng ||
    body.lng > BD_BOUNDS.maxLng
  ) {
    throw fail(StatusCodes.BAD_REQUEST, "Pick a location inside Bangladesh.", "INVALID_LOCATION");
  }
  const maxRadiusKm = await getSetting("homeService.maxRadiusKm");
  const radiusM = Math.min(profile.radiusKm, maxRadiusKm) * 1000;
  const origin = Prisma.sql`ST_SetSRID(ST_MakePoint(${body.lng}::float8, ${body.lat}::float8), 4326)::geography`;
  const [reach] = await prisma.$queryRaw<{ distance_m: number; within: boolean }[]>`
    SELECT ST_Distance(${SALON_GEOG}, ${origin})::float8 AS distance_m,
           ST_DWithin(${SALON_GEOG}, ${origin}, ${radiusM}::float8) AS within
    FROM salons s
    WHERE s.id = ${cart.salonId} AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL`;
  if (!reach?.within) {
    throw fail(StatusCodes.BAD_REQUEST, "This salon doesn't visit that address.", "OUT_OF_SERVICE_AREA", {
      radiusKm: radiusM / 1000,
    });
  }
  const address = {
    addressLine: body.addressLine.trim(),
    area: body.area?.trim() || null,
    landmark: body.landmark?.trim() || null,
    recipientName: body.recipientName.trim(),
    notes: body.notes?.trim() || null,
  };
  const tooLong = (v: string | null, min: number, max: number) => v !== null && (v.length < min || v.length > max);
  if (tooLong(address.addressLine, 5, 200)) throw new ApiError(StatusCodes.BAD_REQUEST, "Enter the address in 5–200 characters.");
  if (tooLong(address.area, 1, 80)) throw new ApiError(StatusCodes.BAD_REQUEST, "Area can be up to 80 characters.");
  if (tooLong(address.landmark, 1, 120)) throw new ApiError(StatusCodes.BAD_REQUEST, "Landmark can be up to 120 characters.");
  if (tooLong(address.recipientName, 2, 80)) throw new ApiError(StatusCodes.BAD_REQUEST, "Enter the name in 2–80 characters.");
  if (tooLong(address.notes, 1, 300)) throw new ApiError(StatusCodes.BAD_REQUEST, "Notes can be up to 300 characters.");
  if ([address.notes, address.addressLine, address.landmark].some((v) => v && URL_LIKE.test(v))) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Links aren't allowed in the address or notes.");
  }
  const contactPhone = bdMobile(body.contactPhone);
  if (!contactPhone) throw new ApiError(StatusCodes.BAD_REQUEST, "Enter an 11-digit mobile number starting 01.");
  if (cart.audience === HomeAudience.LADIES && body.recipientIsWoman !== true) {
    throw fail(
      StatusCodes.BAD_REQUEST,
      "Ladies at Home is for women: confirm the service is for a woman.",
      "RECIPIENT_CONFIRMATION_REQUIRED",
    );
  }

  // Price + policy
  const [advancePercent, commissionPercent, travelFeeMaxMinor, paymentWindowMinutes, policy] = await Promise.all([
    getSetting("homeService.advancePercent"),
    getSetting("homeService.commissionPercent"),
    getSetting("homeService.travelFeeMaxMinor"),
    getSetting("homeService.paymentWindowMinutes"),
    currentPolicy(),
  ]);
  const price = priceCart(cart.items, profile, { advancePercent, commissionPercent, travelFeeMaxMinor });
  const { commissionBps, ...customerPrice } = price;
  const quoteHash = quoteHashOf({
    price: customerPrice,
    policyVersion: policy.version,
    startAt,
    expertId: body.expertId,
    offeringIds: body.offeringIds,
  });

  return {
    now,
    customer,
    cart,
    profile,
    salon,
    expert,
    candidates: slot.expertIds,
    startAt,
    endAt: new Date(startAt.getTime() + cart.durationMin * MIN_MS),
    distanceKm: Math.round(reach.distance_m / 100) / 10,
    address: { ...address, contactPhone, recipientIsWoman: body.recipientIsWoman ?? null },
    price,
    commissionBps,
    paymentWindowMinutes,
    policy,
    quoteHash,
  };
};
type Checked = Awaited<ReturnType<typeof runChecks>>;

const quoteView = (q: Checked, body: QuoteBody) => {
  const { commissionBps: _c, ...price } = q.price;
  return {
    salon: { id: q.salon.id, name: q.salon.name },
    audience: q.cart.audience,
    expertId: body.expertId,
    expert: q.expert,
    date: body.date,
    startAt: q.startAt,
    endAt: q.endAt,
    durationMin: q.cart.durationMin,
    distanceKm: q.distanceKm,
    items: q.cart.items.map((i) => ({ id: i.id, name: i.name, durationMin: i.durationMin, priceMinor: i.priceMinor })),
    ...price,
    policy: policySnapshotOf(q.policy),
    policyVersion: q.policy.version,
    disclaimer: disclaimersOf(q.policy, q.price.advanceMinor),
    requiresAcceptance: requiresAcceptance(q.policy),
    paymentWindowMinutes: q.paymentWindowMinutes,
    quoteHash: q.quoteHash,
  };
};

export const quote = async (actor: Actor, body: QuoteBody) => quoteView(await runChecks(actor, body), body);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => `HS-${Array.from({ length: 4 }, () => B32[randomInt(B32.length)]).join("")}`;

export const isExclusionViolation = (e: unknown) => {
  const err = e as { code?: string; meta?: { code?: string }; message?: string };
  return err?.meta?.code === "23P01" || /23P01|exclusion constraint|home_bookings_no_overlap/i.test(err?.message ?? "");
};
/** Deadlock, write conflict (P2034) or a lock wait past `lock_timeout` (55P03): someone else got there. */
export const isContention = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  return err?.code === "P2034" || /40P01|deadlock detected|55P03|lock timeout/i.test(err?.message ?? "");
};
const isUniqueOn = (e: unknown, field: string) => {
  const err = e as { code?: string; meta?: { target?: unknown } };
  return err?.code === "P2002" && JSON.stringify(err.meta?.target ?? "").includes(field);
};

/** Unpaid bookings of this expert past their window → EXPIRED, under the expert's lock. */
export const expireStaleOf = async (tx: Tx, expertId: string) => {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE home_bookings SET status = 'EXPIRED', "updatedAt" = now()
    WHERE "expertId" = ${expertId} AND status = 'PENDING_PAYMENT' AND "expiresAt" < now()
    RETURNING id`;
  if (rows.length) {
    await tx.homeBookingEvent.createMany({
      data: rows.map((r) => ({
        bookingId: r.id,
        fromStatus: HomeBookingStatus.PENDING_PAYMENT,
        toStatus: HomeBookingStatus.EXPIRED,
        actorRole: "SYSTEM",
        reason: "Not paid in time",
      })),
    });
  }
};

/** "ANY": fewest active jobs that day first, then the better rated. */
const orderCandidates = async (ids: string[], date: string) => {
  if (ids.length < 2) return ids;
  const [jobs, experts] = await Promise.all([
    prisma.homeBooking.groupBy({
      by: ["expertId"],
      where: { expertId: { in: ids }, serviceDate: new Date(`${date}T00:00:00Z`), status: { in: ACTIVE_BOOKING_STATUSES } },
      _count: { _all: true },
    }),
    prisma.homeExpert.findMany({ where: { id: { in: ids } }, select: { id: true, rating: true } }),
  ]);
  const count = new Map(jobs.map((j) => [j.expertId, j._count._all]));
  const rating = new Map(experts.map((e) => [e.id, e.rating]));
  return [...ids].sort(
    (a, b) => (count.get(a) ?? 0) - (count.get(b) ?? 0) || (rating.get(b) ?? 0) - (rating.get(a) ?? 0) || a.localeCompare(b),
  );
};

export const createBooking = async (actor: Actor, body: CreateBookingBody, idempotencyKey: string, lang: DisclaimerLang) => {
  const key = `${actor.userId}:${idempotencyKey}`;
  const replay = await prisma.homeBooking.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
  if (replay) return getBooking(actor.userId, replay.id);

  const q = await runChecks(actor, body);
  const needsAcceptance = requiresAcceptance(q.policy);
  const disclaimer = disclaimersOf(q.policy, q.price.advanceMinor);
  if (needsAcceptance && !body.policyAccepted) {
    throw fail(StatusCodes.BAD_REQUEST, "Please read and accept the cancellation terms.", "POLICY_NOT_ACCEPTED", { disclaimer });
  }
  if (body.policyVersion !== q.policy.version) {
    throw fail(StatusCodes.CONFLICT, "The cancellation terms have just changed. Please review them.", "POLICY_CHANGED", {
      policy: policySnapshotOf(q.policy),
      policyVersion: q.policy.version,
      disclaimer,
      requiresAcceptance: needsAcceptance,
    });
  }
  if (body.quoteHash !== q.quoteHash) {
    throw fail(StatusCodes.CONFLICT, "The price has changed. Please review it before booking.", "PRICE_CHANGED", {
      quote: quoteView(q, body),
    });
  }

  const specific = body.expertId !== "ANY";
  const candidates = specific ? [body.expertId] : await orderCandidates(q.candidates, body.date);

  let bookingId: string;
  try {
    bookingId = await prisma.$transaction(
      async (tx) => {
        // A queue on one stylist ends in a clean SLOT_TAKEN, well inside the
        // transaction's own timeout, instead of a 500 when the timeout hits.
        await tx.$executeRaw`SET LOCAL lock_timeout = '8s'`;
        // One booking at a time per customer, so two tabs can't both pass the
        // pending / active-cap checks. Always before a stylist lock.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('homecustomer:' || ${actor.userId}))`;
        await assertCustomerFree(actor.userId, new Date(), tx);

        const buffer = q.profile.travelBufferMin * MIN_MS;
        const blockFrom = new Date(q.startAt.getTime() - buffer);
        const blockTo = new Date(q.endAt.getTime() + buffer);

        let chosen: { id: string; audience: HomeAudience } | null = null;
        for (const expertId of candidates) {
          const e = await tx.homeExpert.findUnique({ where: { id: expertId }, select: { id: true, staffId: true, audience: true } });
          if (!e) continue;
          await lockStaff(tx, e.staffId);
          await expireStaleOf(tx, e.id);
          // The usual loser: another visit got the time while we queued. One
          // query, so the lock is held briefly; the full check follows.
          const clash = await tx.homeBooking.findFirst({
            where: { expertId: e.id, status: { in: ACTIVE_BOOKING_STATUSES }, blockFrom: { lt: blockTo }, blockTo: { gt: blockFrom } },
            select: { id: true },
          });
          if (clash) continue;
          const { ok } = await expertCanTake({ expertId: e.id, offeringIds: body.offeringIds, startAt: q.startAt, db: tx });
          if (ok) {
            chosen = { id: e.id, audience: e.audience };
            break;
          }
        }
        if (!chosen) {
          throw specific
            ? fail(StatusCodes.CONFLICT, "This time was just taken. Pick another.", "SLOT_TAKEN")
            : fail(StatusCodes.CONFLICT, "No expert is free at that time any more. Pick another.", "NO_EXPERT_FREE");
        }

        let code = newCode();
        for (let i = 0; i < 5 && (await tx.homeBooking.findUnique({ where: { code }, select: { id: true } })); i++) code = newCode();

        const now = new Date();
        const booking = await tx.homeBooking.create({
          data: {
            code,
            customerId: actor.userId,
            salonId: q.cart.salonId,
            expertId: chosen.id,
            audience: q.cart.audience,
            expertAudience: chosen.audience,
            status: HomeBookingStatus.PENDING_PAYMENT,
            startAt: q.startAt,
            endAt: q.endAt,
            blockFrom,
            blockTo,
            serviceDate: new Date(`${body.date}T00:00:00Z`),
            expiresAt: new Date(now.getTime() + q.paymentWindowMinutes * MIN_MS),
            addressLine: q.address.addressLine,
            area: q.address.area,
            landmark: q.address.landmark,
            latitude: body.lat,
            longitude: body.lng,
            distanceKm: q.distanceKm,
            recipientName: q.address.recipientName,
            recipientIsWoman: q.address.recipientIsWoman,
            contactPhone: q.address.contactPhone,
            notes: q.address.notes,
            subtotalMinor: q.price.subtotalMinor,
            travelFeeMinor: q.price.travelFeeMinor,
            totalMinor: q.price.totalMinor,
            advancePercent: q.price.advancePercent,
            advanceMinor: q.price.advanceMinor,
            balanceMinor: q.price.balanceMinor,
            commissionBps: q.commissionBps,
            policySnapshot: { ...policySnapshotOf(q.policy), requiresAcceptance: needsAcceptance } as Prisma.InputJsonValue,
            disclaimerText: buildDisclaimer(q.policy, q.price.advanceMinor, lang),
            policyAcceptedAt: body.policyAccepted ? now : null,
            idempotencyKey: key,
            isTest: q.customer.isTest || q.salon.isTest,
            items: {
              create: q.cart.items.map((i) => ({
                offeringId: i.id,
                nameSnapshot: i.name,
                priceMinor: i.priceMinor,
                durationMin: i.durationMin,
              })),
            },
            events: {
              create: { toStatus: HomeBookingStatus.PENDING_PAYMENT, actorId: actor.userId, actorRole: "CUSTOMER" },
            },
          },
          select: { id: true },
        });
        return booking.id;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  } catch (e) {
    if (isUniqueOn(e, "idempotencyKey")) {
      const won = await prisma.homeBooking.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
      if (won) return getBooking(actor.userId, won.id);
    }
    if (isExclusionViolation(e) || isContention(e)) {
      throw fail(StatusCodes.CONFLICT, "This time was just taken. Pick another.", "SLOT_TAKEN");
    }
    throw e;
  }
  return getBooking(actor.userId, bookingId);
};

// ---------------------------------------------------------------------------
// Pay the advance
// ---------------------------------------------------------------------------

const PAID_STATUSES: HomeBookingStatus[] = [
  HomeBookingStatus.CONFIRMED,
  HomeBookingStatus.EN_ROUTE,
  HomeBookingStatus.ARRIVED,
  HomeBookingStatus.IN_PROGRESS,
  HomeBookingStatus.COMPLETED,
];

const expireOne = async (tx: Tx, id: string, reason: string) => {
  const n = await tx.homeBooking.updateMany({
    where: { id, status: HomeBookingStatus.PENDING_PAYMENT },
    data: { status: HomeBookingStatus.EXPIRED },
  });
  if (n.count) {
    await tx.homeBookingEvent.create({
      data: { bookingId: id, fromStatus: HomeBookingStatus.PENDING_PAYMENT, toStatus: HomeBookingStatus.EXPIRED, actorRole: "SYSTEM", reason },
    });
  }
};

export type ConfirmResult = { status: HomeBookingStatus; walletCreditedMinor?: number };

/**
 * Holds the advance from the wallet and confirms, under the expert's stylist
 * lock. Idempotent (the hold is keyed `homehold:<id>`, the move is
 * conditional on the status read under the lock).
 *
 * `fromGateway`: the money arrived through a HOME_BOOKING intent and is
 * already in the wallet. Then a booking past its window is re-reserved for
 * the same expert and time if that is still free, and otherwise left EXPIRED
 * with the money staying in the wallet. From the pay endpoint
 * (`fromGateway` false) a wallet problem is the caller's error.
 */
export const confirmPaidHomeBooking = async (
  bookingId: string,
  creditedMinor = 0,
  opts: { fromGateway?: boolean; actorId?: string } = {},
): Promise<ConfirmResult> => {
  const fromGateway = opts.fromGateway ?? true;
  const head = await prisma.homeBooking.findUnique({ where: { id: bookingId }, select: { expert: { select: { staffId: true } } } });
  if (!head) throw new ApiError(StatusCodes.NOT_FOUND, "Booking not found");
  const credited = creditedMinor > 0 ? { walletCreditedMinor: creditedMinor } : {};

  const result = await prisma.$transaction(
    async (tx): Promise<ConfirmResult & { confirmedNow?: true }> => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '8s'`;
      await lockStaff(tx, head.expert.staffId);
      const b = await tx.homeBooking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          status: true,
          expiresAt: true,
          customerId: true,
          expertId: true,
          advanceMinor: true,
          startAt: true,
          createdAt: true,
          items: { select: { offeringId: true } },
        },
      });
      if (!b) throw new ApiError(StatusCodes.NOT_FOUND, "Booking not found");
      if (PAID_STATUSES.includes(b.status)) return { status: b.status };

      const now = new Date();
      const inTime = b.status === HomeBookingStatus.PENDING_PAYMENT && !!b.expiresAt && b.expiresAt > now;
      const late = !inTime;
      if (late) {
        const reopenable = b.status === HomeBookingStatus.PENDING_PAYMENT || b.status === HomeBookingStatus.EXPIRED;
        if (!fromGateway || !reopenable || b.startAt <= now) {
          await expireOne(tx, b.id, "Not paid in time");
          return { status: reopenable ? HomeBookingStatus.EXPIRED : b.status, ...credited };
        }
        if (b.status === HomeBookingStatus.EXPIRED) {
          // Someone may have the time now. Judged as of the original booking
          // (lead time, window), with today's busy times.
          await expireStaleOf(tx, b.expertId);
          const check = await expertCanTake({
            expertId: b.expertId,
            offeringIds: b.items.map((i) => i.offeringId),
            startAt: b.startAt,
            now: b.createdAt,
            excludeBookingId: b.id,
            db: tx,
          }).catch((e) => {
            if (e instanceof ApiError) return { ok: false };
            throw e;
          });
          if (!check.ok) return { status: HomeBookingStatus.EXPIRED, ...credited };
        }
      }

      try {
        await WalletService.holdHomeAdvance(b.customerId, b.advanceMinor, b.id, tx);
      } catch (e) {
        // Nothing was written: `mutate` checks before it writes.
        if (!fromGateway || !(e instanceof ApiError)) throw e;
        if (late) await expireOne(tx, b.id, "Advance could not be held");
        return { status: late ? HomeBookingStatus.EXPIRED : b.status, ...credited };
      }

      const moved = await tx.homeBooking.updateMany({
        where: { id: b.id, status: b.status },
        data: { status: HomeBookingStatus.CONFIRMED, advanceStatus: AdvanceStatus.HELD, confirmedAt: now },
      });
      if (!moved.count) throw fail(StatusCodes.CONFLICT, "This booking changed. Refresh and try again.", "INVALID_STATE");
      await tx.homeBookingEvent.create({
        data: {
          bookingId: b.id,
          fromStatus: b.status,
          toStatus: HomeBookingStatus.CONFIRMED,
          actorId: opts.actorId ?? null,
          actorRole: opts.actorId ? "CUSTOMER" : "SYSTEM",
          reason: late ? "Paid after the payment window" : null,
        },
      });
      return { status: HomeBookingStatus.CONFIRMED, ...credited, confirmedNow: true };
    },
    { maxWait: 10_000, timeout: 20_000 },
  );
  // Only the call that moved it tells anyone (a repeat finds it already paid).
  const { confirmedNow, ...out } = result;
  if (confirmedNow) homeNotice(bookingId, { kind: "confirmed" });
  return out;
};

export const payBooking = async (actor: Actor, id: string, method: "WALLET" | ProviderName) => {
  if (actor.impersonating) {
    throw fail(StatusCodes.FORBIDDEN, "Read-only view: changes are not allowed while viewing as this user.", "IMPERSONATION_READ_ONLY");
  }
  const b = await prisma.homeBooking.findFirst({
    where: { id, customerId: actor.userId },
    select: { id: true, status: true, expiresAt: true, advanceMinor: true },
  });
  if (!b) throw new ApiError(StatusCodes.NOT_FOUND, "Booking not found");
  if (PAID_STATUSES.includes(b.status)) return { status: b.status, paidFrom: null, booking: await getBooking(actor.userId, id) };

  const now = new Date();
  if (b.status === HomeBookingStatus.EXPIRED || (b.status === HomeBookingStatus.PENDING_PAYMENT && (!b.expiresAt || b.expiresAt <= now))) {
    throw fail(StatusCodes.CONFLICT, "The time to pay for this booking has run out. Please book again.", "PAYMENT_EXPIRED");
  }
  if (b.status !== HomeBookingStatus.PENDING_PAYMENT) {
    throw fail(StatusCodes.CONFLICT, "This booking can't be paid for.", "INVALID_STATE");
  }

  const wallet = await WalletService.getOrCreateWallet(actor.userId);
  if (wallet.isFrozen) throw fail(StatusCodes.FORBIDDEN, "Your wallet is frozen. Contact support.", "WALLET_FROZEN");
  const available = WalletService.availableOf(wallet);

  if (available >= b.advanceMinor) {
    const r = await confirmPaidHomeBooking(b.id, 0, { fromGateway: false, actorId: actor.userId });
    if (r.status !== HomeBookingStatus.CONFIRMED) {
      throw fail(StatusCodes.CONFLICT, "The time to pay for this booking has run out. Please book again.", "PAYMENT_EXPIRED");
    }
    return { status: r.status, paidFrom: "WALLET" as const, booking: await getBooking(actor.userId, id) };
  }

  const shortfallMinor = b.advanceMinor - Math.max(available, 0);
  if (method === "WALLET") {
    const short = new ApiError(StatusCodes.BAD_REQUEST, "Your wallet doesn't cover the advance. Pay the rest with bKash or card.");
    short.details = { shortfallMinor };
    throw short;
  }
  const session = await PaymentIntentService.initiateHomeBookingPayment(actor.userId, b.id, shortfallMinor, method);
  await prisma.homeBooking.update({ where: { id: b.id }, data: { paymentIntentId: session.intentId } });
  return {
    status: HomeBookingStatus.PENDING_PAYMENT,
    paidFrom: method,
    redirectUrl: session.redirectUrl,
    transactionId: session.transactionId,
    amountMinor: session.amountMinor,
    shortfallMinor,
  };
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const EXPERT_CARD = {
  id: true,
  audience: true,
  headline: true,
  languages: true,
  rating: true,
  totalReviews: true,
  completedJobs: true,
  staff: { select: { user: { select: { name: true, profilePhoto: true } } } },
} satisfies Prisma.HomeExpertSelect;

const expertCardOf = (e: Prisma.HomeExpertGetPayload<{ select: typeof EXPERT_CARD }>) => ({
  id: e.id,
  name: e.staff.user.name,
  photo: e.staff.user.profilePhoto ?? null,
  audience: e.audience,
  headline: e.headline,
  languages: e.languages,
  rating: e.rating,
  totalReviews: e.totalReviews,
  completedJobs: e.completedJobs,
});

async function loadExpertCard(id: string) {
  const e = await prisma.homeExpert.findUnique({ where: { id }, select: EXPERT_CARD });
  return e ? expertCardOf(e) : null;
}

const SUMMARY = {
  id: true,
  code: true,
  status: true,
  audience: true,
  startAt: true,
  endAt: true,
  expiresAt: true,
  totalMinor: true,
  advanceMinor: true,
  balanceMinor: true,
  advanceStatus: true,
  createdAt: true,
  salon: { select: { id: true, name: true, area: true, images: true } },
  expert: { select: EXPERT_CARD },
  items: { select: { nameSnapshot: true } },
} satisfies Prisma.HomeBookingSelect;

const summaryOf = (b: Prisma.HomeBookingGetPayload<{ select: typeof SUMMARY }>) => ({
  id: b.id,
  code: b.code,
  status: b.status,
  audience: b.audience,
  startAt: b.startAt,
  endAt: b.endAt,
  expiresAt: b.status === HomeBookingStatus.PENDING_PAYMENT ? b.expiresAt : null,
  totalMinor: b.totalMinor,
  advanceMinor: b.advanceMinor,
  balanceMinor: b.balanceMinor,
  advanceStatus: b.advanceStatus,
  createdAt: b.createdAt,
  salon: { id: b.salon.id, name: b.salon.name, area: b.salon.area, image: b.salon.images[0] ?? null },
  expert: expertCardOf(b.expert),
  services: b.items.map((i) => i.nameSnapshot),
});

export const listMyBookings = async (userId: string, tab: "upcoming" | "past", page: number) => {
  const where: Prisma.HomeBookingWhereInput = {
    customerId: userId,
    status: tab === "upcoming" ? { in: ACTIVE_BOOKING_STATUSES } : { notIn: ACTIVE_BOOKING_STATUSES },
  };
  const [total, rows] = await Promise.all([
    prisma.homeBooking.count({ where }),
    prisma.homeBooking.findMany({
      where,
      select: SUMMARY,
      orderBy: [{ startAt: tab === "upcoming" ? "asc" : "desc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  return { meta: { page, limit: PAGE_SIZE, total }, data: rows.map(summaryOf) };
};

/** The customer's own booking; anyone else's is 404. */
export const getBooking = async (userId: string, id: string) => {
  const b = await prisma.homeBooking.findFirst({
    where: { id, customerId: userId },
    select: {
      ...SUMMARY,
      serviceDate: true,
      addressLine: true,
      area: true,
      landmark: true,
      latitude: true,
      longitude: true,
      distanceKm: true,
      recipientName: true,
      recipientIsWoman: true,
      contactPhone: true,
      notes: true,
      subtotalMinor: true,
      travelFeeMinor: true,
      advancePercent: true,
      policySnapshot: true,
      disclaimerText: true,
      policyAcceptedAt: true,
      confirmedAt: true,
      balanceMethod: true,
      cancelledAt: true,
      cancelledBy: true,
      cancelReason: true,
      noShowParty: true,
      feeMinor: true,
      refundedMinor: true,
      rescheduleCount: true,
      appealStatus: true,
      appealedAt: true,
      items: { select: { offeringId: true, nameSnapshot: true, priceMinor: true, durationMin: true } },
      events: { select: { fromStatus: true, toStatus: true, actorRole: true, reason: true, createdAt: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!b) throw new ApiError(StatusCodes.NOT_FOUND, "Booking not found");
  const { items, events, policySnapshot, ...rest } = b;
  return {
    ...summaryOf({ ...b, items: items.map((i) => ({ nameSnapshot: i.nameSnapshot })) }),
    serviceDate: rest.serviceDate.toISOString().slice(0, 10),
    address: {
      addressLine: rest.addressLine,
      area: rest.area,
      landmark: rest.landmark,
      latitude: rest.latitude,
      longitude: rest.longitude,
      distanceKm: rest.distanceKm,
    },
    recipientName: rest.recipientName,
    recipientIsWoman: rest.recipientIsWoman,
    contactPhone: rest.contactPhone,
    notes: rest.notes,
    subtotalMinor: rest.subtotalMinor,
    travelFeeMinor: rest.travelFeeMinor,
    advancePercent: rest.advancePercent,
    items: items.map((i) => ({ offeringId: i.offeringId, name: i.nameSnapshot, priceMinor: i.priceMinor, durationMin: i.durationMin })),
    policy: policySnapshot,
    disclaimerText: rest.disclaimerText,
    policyAcceptedAt: rest.policyAcceptedAt,
    confirmedAt: rest.confirmedAt,
    cancelledAt: rest.cancelledAt,
    cancelledBy: rest.cancelledBy,
    cancelReason: rest.cancelReason,
    noShowParty: rest.noShowParty,
    feeMinor: rest.feeMinor,
    refundedMinor: rest.refundedMinor,
    rescheduleCount: rest.rescheduleCount,
    appealStatus: rest.appealStatus,
    appealedAt: rest.appealedAt,
    timeline: events,
    // The 4-digit code the customer reads out at the door (until the visit starts).
    startCode: startCodeFor({ id: b.id, status: b.status }),
    balanceMethod: rest.balanceMethod,
    balanceHeldInApp: rest.balanceMethod === "WALLET",
  };
};
