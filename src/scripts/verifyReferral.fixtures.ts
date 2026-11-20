/**
 * Fixtures for `verify:referral`: committed rows on the TEST database only
 * (the HTTP and job paths need them), all `isTest = true` and on
 * `ref-verify.<key>.<tag>@seed.example.com`, removed by `removeFixtures` in the
 * caller's `finally`. Settings changed here are put back by `restoreSettings`.
 */
import { randomInt, randomUUID } from "crypto";
import {
  AdminRole,
  ExpertVerification,
  Gender,
  HomeAudience,
  HomeCategory,
  HomeServiceStatus,
  Prisma,
  RewardStatus,
  SalonStatus,
  UserRole,
} from "@prisma/client";
import prisma from "../app/shared/prisma";
import { setSetting, type SettingKey } from "../app/utils/settings";
import { systemAuditCtx, type AuditCtx } from "../app/utils/audit";
import { ensureCode } from "../app/modules/Referral/referral.codes";
import { issueWelcomeTx } from "../app/modules/Referral/referral.attach";

export type Check = (name: string, ok: boolean, detail?: string) => void;

export const TAG = randomUUID().slice(0, 8);
export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Every user this run made, so cleanup can find the few not on the marker domain. */
const userIds = new Set<string>();
const salonIds = new Set<string>();
const ownerIds = new Set<string>();

export const emailOf = (key: string) => `ref-verify.${key}.${TAG}@seed.example.com`;
export const track = (id: string) => userIds.add(id);

let phoneSeq = randomInt(1_000_000, 8_000_000);
/** A fresh valid `019XXXXXXXX` number per customer, so no two fixtures share one by accident. */
export const freshPhone = () => `019${String((phoneSeq += 7)).padStart(8, "0")}`;

export type Person = { id: string; email: string; role: UserRole; name: string; phone: string | null };

export const person = async (
  key: string,
  role: UserRole = UserRole.CUSTOMER,
  extra: Partial<Prisma.UserUncheckedCreateInput> = {},
): Promise<Person> => {
  const u = await prisma.user.create({
    data: {
      email: emailOf(key),
      name: `Verify ${key}`,
      role,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      isTest: true,
      phone: role === UserRole.CUSTOMER ? freshPhone() : null,
      ...extra,
    },
    select: { id: true, email: true, role: true, name: true, phone: true },
  });
  track(u.id);
  return u;
};

/** A referrer with a code. */
export const referrer = async (key: string, extra: Partial<Prisma.UserUncheckedCreateInput> = {}) => {
  const u = await person(key, UserRole.CUSTOMER, extra);
  const code = await ensureCode(u.id);
  return { ...u, code: code.code };
};

/**
 * A referee who joined through `ref` (JOINED, joined `joinedAgoMs` ago) with
 * the welcome reward issued through the real `issueWelcomeTx`.
 */
export const joinedReferee = async (
  key: string,
  ref: { id: string; code: string },
  o: { flags?: string[]; joinedAgoMs?: number; welcome?: boolean; phone?: string | null } = {},
) => {
  const u = await person(key, UserRole.CUSTOMER, o.phone !== undefined ? { phone: o.phone } : {});
  const joinedAt = new Date(Date.now() - (o.joinedAgoMs ?? HOUR));
  const referral = await prisma.referral.create({
    data: {
      referrerId: ref.id,
      refereeId: u.id,
      code: ref.code,
      channel: "CODE",
      status: "JOINED",
      riskFlags: o.flags ?? [],
      joinedAt,
      isTest: true,
    },
  });
  let welcomeId: string | null = null;
  if (o.welcome !== false) {
    const w = await prisma.$transaction((tx) => issueWelcomeTx(tx, u.id));
    welcomeId = w?.reward.id ?? null;
  }
  return { ...u, referralId: referral.id, welcomeId };
};

/** A manual reward straight into the table (no referral behind it, as the CHECK wants). */
export const grantRow = (
  userId: string,
  o: { percentBps?: number; maxDiscountMinor?: number; scope?: "ALL" | "SALON" | "HOME"; expiresInMs?: number; status?: RewardStatus } = {},
) =>
  prisma.referralReward.create({
    data: {
      userId,
      kind: "MANUAL_GRANT",
      status: o.status ?? RewardStatus.AVAILABLE,
      percentBps: o.percentBps ?? 1000,
      maxDiscountMinor: o.maxDiscountMinor ?? 0,
      scope: o.scope ?? "ALL",
      expiresAt: new Date(Date.now() + (o.expiresInMs ?? 30 * DAY)),
      grantReason: "verify:referral",
    },
  });

export const rewardOf = (id: string) => prisma.referralReward.findUniqueOrThrow({ where: { id } });

// ---------------------------------------------------------------------------
// The world: one business, one ACTIVE salon with a service and a counter, a
// Ladies home profile with one verified female expert, and an admin.
// ---------------------------------------------------------------------------

export const PRICE = 200_000; // ৳2,000 salon service
export const HOME_PRICE = 130_000; // ৳1,300 home facial
export const LAT = 23.81;
export const LNG = 90.41;

export type World = Awaited<ReturnType<typeof buildWorld>>;

export const buildWorld = async () => {
  const ownerUser = await person("owner", UserRole.SALON_OWNER);
  const owner = await prisma.salonOwner.create({ data: { userId: ownerUser.id, businessName: `Verify Referral ${TAG}` } });
  ownerIds.add(owner.id);
  const salon = await prisma.salon.create({
    data: {
      name: `Verify Referral ${TAG}`,
      address: "Mirpur test road",
      area: "Mirpur",
      city: "Dhaka",
      phone: "01700000000",
      images: [],
      ownerId: owner.id,
      status: SalonStatus.ACTIVE,
      latitude: LAT,
      longitude: LNG,
      isTest: true,
    },
  });
  salonIds.add(salon.id);
  const service = await prisma.service.create({
    data: { name: "Verify cut", category: "HAIRCUT", priceMinor: PRICE, duration: 60, salonId: salon.id, images: [] },
  });
  const counter = await prisma.counter.create({ data: { salonId: salon.id, name: "Verify chair" } });

  await prisma.homeServiceProfile.create({
    data: { salonId: salon.id, isOn: true, ladiesEnabled: true, gentsEnabled: false, status: HomeServiceStatus.ACTIVE, everApproved: true },
  });
  const offering = await prisma.homeServiceOffering.create({
    data: { salonId: salon.id, audience: HomeAudience.LADIES, category: HomeCategory.FACIAL, name: "Verify facial", durationMin: 60, priceMinor: HOME_PRICE, images: [] },
  });
  const expertUser = await person("expert", UserRole.STAFF, { gender: Gender.FEMALE });
  const staff = await prisma.staff.create({ data: { userId: expertUser.id, salonId: salon.id } });
  const expert = await prisma.homeExpert.create({
    data: {
      staffId: staff.id,
      salonId: salon.id,
      gender: Gender.FEMALE,
      audience: HomeAudience.LADIES,
      verification: ExpertVerification.VERIFIED,
      languages: [],
      maxJobsPerDay: 12,
      offerings: { create: { offeringId: offering.id } },
    },
  });

  const admin = await person("admin", UserRole.ADMIN);
  await prisma.admin.create({ data: { userId: admin.id, adminRole: AdminRole.SUPER_ADMIN } });
  const adminCtx: AuditCtx = { ...systemAuditCtx("cli"), actorUserId: admin.id, actorRole: "ADMIN" };

  return {
    owner: ownerUser,
    ownerActor: { userId: ownerUser.id, role: UserRole.SALON_OWNER as string },
    ownerId: owner.id,
    salonId: salon.id,
    serviceId: service.id,
    counterId: counter.id,
    offeringId: offering.id,
    expertId: expert.id,
    expertUserId: expertUser.id,
    admin,
    adminCtx,
  };
};

// ---------------------------------------------------------------------------
// Time. Slot times are server-local wall clock (`atWallClock`), so these are too.
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** `at` as the stored pair: the calendar day as UTC midnight, and "HH:mm". */
export const wallClock = (at: Date) => ({
  date: new Date(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())),
  time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
});

let slotSeq = 0;
/**
 * A free slot `dayOffset` days from today at 10:00 + n hours, so no two of one
 * customer overlap on a day.
 */
export const slot = async (w: World, dayOffset: number, hour?: number) => {
  const h = hour ?? 9 + (slotSeq++ % 10);
  const day = new Date();
  day.setDate(day.getDate() + dayOffset);
  day.setHours(h, 0, 0, 0);
  const { date } = wallClock(day);
  return prisma.slot.create({
    data: { salonId: w.salonId, serviceId: w.serviceId, counterId: w.counterId, date, startTime: `${pad(h)}:00`, endTime: `${pad(h + 1)}:00` },
  });
};

/** Moves a booking so it starts `offsetMin` from now (negative = already started). */
export const timeTravel = async (appointmentId: string, offsetMin: number) => {
  const start = wallClock(new Date(Date.now() + offsetMin * MIN));
  const end = wallClock(new Date(Date.now() + (offsetMin + 60) * MIN));
  await prisma.appointment.update({
    where: { id: appointmentId },
    data: { appointmentDate: start.date, startTime: start.time, endTime: end.time },
  });
};

export const bookingBody = (w: World, slotId: string, rewardId?: string | null) => ({
  salonId: w.salonId,
  serviceId: w.serviceId,
  counterId: w.counterId,
  slotId,
  ...(rewardId !== undefined ? { rewardId } : {}),
});

// ---------------------------------------------------------------------------
// Settings: changed through `setSetting` (cache updated at once), put back at the end.
// ---------------------------------------------------------------------------

const before = new Map<string, Prisma.JsonValue | undefined>();
const settingsCtx = systemAuditCtx("cli");

export const setSettings = async (values: Partial<Record<SettingKey, unknown>>) => {
  for (const [key, value] of Object.entries(values)) {
    if (!before.has(key)) {
      const row = await prisma.platformSetting.findUnique({ where: { key } });
      before.set(key, row ? row.value : undefined);
    }
    await setSetting(key as SettingKey, value, settingsCtx, "verify:referral (test database only)");
  }
};

export const restoreSettings = async () => {
  for (const [key, value] of before) {
    if (value === undefined) await prisma.platformSetting.deleteMany({ where: { key } });
    else await prisma.platformSetting.update({ where: { key }, data: { value: value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue) } });
  }
  before.clear();
};

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Removes every row this run made: by the tracked ids and by the marker
 * domain. Each statement runs on its own so one failure does not keep the
 * rest; whatever is left is reported, not fatal.
 */
export const removeFixtures = async (): Promise<string[]> => {
  const found = await prisma.user
    .findMany({ where: { email: { startsWith: "ref-verify.", endsWith: `.${TAG}@seed.example.com` } }, select: { id: true } })
    .catch(() => [] as Array<{ id: string }>);
  for (const u of found) userIds.add(u.id);
  const users = [...userIds];
  const salons = [...salonIds];
  const owners = [...ownerIds];
  const problems: string[] = [];
  if (!users.length) return problems;

  const U = Prisma.join(users);
  const S = salons.length ? Prisma.join(salons) : Prisma.join(["-"]);
  const O = owners.length ? Prisma.join(owners) : Prisma.join(["-"]);
  const steps: Array<[string, Prisma.Sql]> = [
    ["referral events", Prisma.sql`DELETE FROM referral_events WHERE "referralId" IN (SELECT id FROM referrals WHERE "referrerId" IN (${U}) OR "refereeId" IN (${U}))
       OR "rewardId" IN (SELECT id FROM referral_rewards WHERE "userId" IN (${U})) OR "actorId" IN (${U}) OR data->>'userId' IN (${U})`],
    ["referral rewards", Prisma.sql`DELETE FROM referral_rewards WHERE "userId" IN (${U})`],
    ["referrals", Prisma.sql`DELETE FROM referrals WHERE "referrerId" IN (${U}) OR "refereeId" IN (${U})`],
    ["ledger", Prisma.sql`DELETE FROM ledger_entries WHERE "salonId" IN (${S}) OR "ownerId" IN (${O})
       OR "appointmentId" IN (SELECT id FROM appointments WHERE "customerId" IN (${U}))
       OR "homeBookingId" IN (SELECT id FROM home_bookings WHERE "customerId" IN (${U}))`],
    ["reviews", Prisma.sql`DELETE FROM reviews WHERE "salonId" IN (${S})`],
    ["home bookings", Prisma.sql`DELETE FROM home_bookings WHERE "salonId" IN (${S}) OR "customerId" IN (${U})`],
    ["appointments", Prisma.sql`DELETE FROM appointments WHERE "salonId" IN (${S}) OR "customerId" IN (${U})`],
    ["payment intents", Prisma.sql`DELETE FROM payment_intents WHERE "userId" IN (${U})`],
    ["salons", Prisma.sql`DELETE FROM salons WHERE id IN (${S})`],
    ["salon owners", Prisma.sql`DELETE FROM salon_owners WHERE id IN (${O}) OR "userId" IN (${U})`],
    ["support tickets", Prisma.sql`DELETE FROM support_tickets WHERE "userId" IN (${U})`],
    ["wallet transactions", Prisma.sql`DELETE FROM wallet_transactions WHERE "walletId" IN (SELECT id FROM wallets WHERE "userId" IN (${U}))`],
    ["wallets", Prisma.sql`DELETE FROM wallets WHERE "userId" IN (${U})`],
    ["users", Prisma.sql`DELETE FROM users WHERE id IN (${U})`],
  ];
  for (const [label, sql] of steps) {
    try {
      await prisma.$executeRaw(sql);
    } catch (e) {
      problems.push(`${label}: ${e instanceof Error ? e.message.split("\n").filter(Boolean).pop() : String(e)}`);
    }
  }
  const left = await prisma.user.count({ where: { id: { in: users } } }).catch(() => -1);
  if (left !== 0) problems.push(`${left} user(s) left`);
  return problems;
};
