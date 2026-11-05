/**
 * Home Service demo data: EVERY active salon and parlour serves Home Service
 * on every side its audience allows (LADIES → Ladies, GENTS → Gents, UNISEX →
 * both), with a home menu and at least MIN_EXPERTS verified experts per side.
 *
 *   npm run seed:home                 dry run: what would be written, per salon kind
 *   npm run seed:home -- --apply      write it (test branch when .env.homebranch has one)
 *   npm run seed:home -- --remove     delete what --apply wrote
 *   add --env-db to any of them for the .env database
 *
 * Re-runnable: a salon that already has a profile is topped up, never
 * duplicated — it is switched on with every allowed side enabled, a side with
 * no live menu gets one, and a side with no bookable expert gets experts.
 * Experts come from the salon's own staff of the matching gender (the
 * LADIES ⇔ FEMALE, GENTS ⇔ MALE invariant is a database CHECK); where it has
 * none, a staff member is created for home visits (`home-expert.*@seed.example.com`,
 * isTest, no password). They join the salon's team like any stylist (no shift
 * pattern → the salon's hours) and are linked to no salon service. Experts get
 * no rating or reviews (no Review rows would back them).
 *
 * Left alone and reported: a profile an admin SUSPENDED or REJECTED, a profile
 * the owner paused, a salon whose bookings are paused, and a salon with no pin
 * (home reach is measured from it).
 *
 * --remove deletes the profiles, menus and experts of branches this script
 * created (`statusReason = MARK`) and every `home-expert.*` staff member it
 * created, skipping any salon that already has a home booking (bookings are
 * Restrict, and are someone's test data). Menus it added to a profile it did
 * not create stay.
 */
import { onHomeBranch } from "./homeBranchEnv"; // first: picks the database
import "../config";
import { createHash, randomUUID } from "crypto";
import {
  BookingPause,
  ExpertVerification,
  Gender,
  HomeAudience,
  HomeCategory,
  HomeServiceStatus,
  Prisma,
  SalonStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import prisma from "../app/shared/prisma";
import { allowedSidesOf, loadHomeFlags } from "../app/modules/HomeService/home.owner";

const MARK = "seed:home-demo";
const SEED_DOMAIN = "seed.example.com";
const EXPERT_EMAIL_PREFIX = "home-expert.";
/** Experts taken from the salon's own staff per side, at most. */
const MAX_EXPERTS_PER_SIDE = 3;
/** Every side ends with at least this many bookable experts. */
const MIN_EXPERTS = 2;

const apply = process.argv.includes("--apply");
const remove = process.argv.includes("--remove");

type Item = {
  category: HomeCategory;
  name: string;
  durationMin: number;
  /** Taka; each salon varies it by up to ±15%. */
  price: number;
  description: string;
  kitNote: string;
};

const LADIES: Item[] = [
  { category: "FACIAL", name: "Gold facial", durationMin: 60, price: 1500, description: "Cleansing, scrub, massage and a gold mask for a bright glow.", kitNote: "Facial kit, steamer, fresh towels" },
  { category: "FACIAL", name: "Fruit facial", durationMin: 45, price: 900, description: "A gentle facial for every skin type.", kitNote: "Facial kit, fresh towels" },
  { category: "THREADING", name: "Eyebrow & upper lip threading", durationMin: 20, price: 200, description: "Clean, shaped brows and upper lip.", kitNote: "Thread, antiseptic, cotton" },
  { category: "THREADING", name: "Full face threading", durationMin: 30, price: 450, description: "Brows, upper lip, chin, forehead and sides.", kitNote: "Thread, antiseptic, cotton" },
  { category: "WAXING", name: "Full arms waxing", durationMin: 30, price: 700, description: "Rica wax for smooth arms, gentle on skin.", kitNote: "Rica wax, heater, disposable strips and sheets" },
  { category: "WAXING", name: "Full legs waxing", durationMin: 45, price: 1100, description: "Rica wax, both legs.", kitNote: "Rica wax, heater, disposable strips and sheets" },
  { category: "MEHEDI", name: "Party mehedi (both hands)", durationMin: 45, price: 800, description: "Front and back designs for a party or Eid.", kitNote: "Natural mehedi cones" },
  { category: "MAKEUP", name: "Party makeup", durationMin: 75, price: 2500, description: "Base, eyes and lips with a simple hairdo.", kitNote: "Full makeup kit, brushes, lashes" },
  { category: "MANICURE_PEDICURE", name: "Manicure & pedicure", durationMin: 75, price: 1400, description: "Soak, scrub, cuticle care, massage and polish.", kitNote: "Tub, tools sterilised per visit, polish" },
  { category: "HAIR", name: "Hair spa", durationMin: 60, price: 1600, description: "Deep conditioning treatment with a head massage.", kitNote: "Hair spa cream, steamer cap, towels" },
  { category: "BRIDAL", name: "Bridal makeup & hairdo", durationMin: 180, price: 12000, description: "Full bridal look, trial on request.", kitNote: "Bridal makeup kit, lashes, hair accessories" },
];

const GENTS: Item[] = [
  { category: "HAIRCUT", name: "Haircut", durationMin: 30, price: 400, description: "Any style, with a wash and set.", kitNote: "Clippers, scissors, cape, neck strips" },
  { category: "HAIRCUT", name: "Haircut & beard", durationMin: 45, price: 650, description: "Haircut plus a beard trim and shape.", kitNote: "Clippers, trimmer, cape, aftershave" },
  { category: "BEARD", name: "Beard trim & shape", durationMin: 20, price: 250, description: "Line-up and shape with a hot towel.", kitNote: "Trimmer, razor with new blade, hot towel" },
  { category: "FACIAL", name: "Men's facial", durationMin: 45, price: 1000, description: "Deep cleanse, scrub and mask for oily skin.", kitNote: "Facial kit, fresh towels" },
  { category: "MASSAGE", name: "Head & shoulder massage", durationMin: 30, price: 500, description: "Oil massage to ease a long day.", kitNote: "Massage oil, towels" },
  { category: "HAIR", name: "Hair colour", durationMin: 45, price: 900, description: "Natural black or brown, ammonia-free.", kitNote: "Colour, gloves, cape" },
  { category: "GROOMING", name: "Groom package", durationMin: 120, price: 3500, description: "Haircut, beard, facial and a clean-up for the big day.", kitNote: "Full grooming kit" },
];

/** Names for home-only experts a salon has no matching staff for. */
const EXPERT_NAMES: Record<HomeAudience, string[]> = {
  LADIES: ["Nusrat Jahan", "Farhana Akter", "Sadia Islam", "Tania Sultana", "Sharmin Nahar", "Rumana Haque", "Mousumi Begum", "Afsana Ferdous", "Israt Khatun", "Tahmina Rahman", "Sanjida Yasmin", "Lubna Chowdhury"],
  GENTS: ["Rafiq Hossain", "Sumon Mia", "Imran Khan", "Rakib Ahmed", "Tanvir Islam", "Sabbir Rahman", "Mamun Uddin", "Arif Sarker", "Nayeem Bhuiyan", "Fahim Talukder", "Gopal Shil", "Ratan Shil"],
};

const genderOf = (side: HomeAudience) => (side === HomeAudience.LADIES ? Gender.FEMALE : Gender.MALE);

/** Deterministic 0..1 from a string, so a re-run picks the same menus. */
const rand = (seed: string) => parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) / 0xffffffff;

const menuFor = (salonId: string, audience: HomeAudience) => {
  const items = audience === HomeAudience.LADIES ? LADIES : GENTS;
  // 5 to all items, always keeping the first two (the most booked).
  const keep = items.filter((it, i) => i < 2 || rand(`${salonId}:${it.name}`) < 0.7);
  return keep.map((it, i) => {
    const factor = 0.85 + rand(`${salonId}:${it.name}:price`) * 0.3;
    return {
      ...it,
      sortOrder: i,
      priceMinor: Math.round((it.price * factor) / 10) * 10 * 100,
    };
  });
};

/** Every expert does the first two; the rest is split so menus differ. With 2+ experts every item is covered. */
const linksFor = <T>(offerings: T[], expertIndex: number) =>
  offerings.filter((_, j) => j < 2 || (j + expertIndex) % 3 !== 0);

const headlineFor = (side: HomeAudience, speciality: string | null) =>
  speciality ?? (side === HomeAudience.LADIES ? "Facials, threading and party looks at home" : "Haircuts and grooming at home");

const phoneFor = (seed: string) =>
  `01${"3456789"[Math.floor(rand(`${seed}:p1`) * 7)]}${String(Math.floor(rand(`${seed}:p2`) * 1e8)).padStart(8, "0")}`;

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const loadSalons = () =>
  prisma.salon.findMany({
    where: { status: SalonStatus.ACTIVE, isDeleted: false },
    select: {
      id: true,
      name: true,
      area: true,
      audience: true,
      isTest: true,
      latitude: true,
      longitude: true,
      bookingPause: true,
      homeProfile: {
        select: { id: true, isOn: true, ladiesEnabled: true, gentsEnabled: true, status: true, pausedUntil: true, statusReason: true },
      },
      homeOfferings: {
        where: { isActive: true, isDeleted: false },
        select: { id: true, audience: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      },
      homeExperts: {
        where: { verification: ExpertVerification.VERIFIED, isActive: true, removedAt: null, staff: { isDeleted: false } },
        select: { audience: true, offerings: { where: { offering: { isActive: true, isDeleted: false } }, select: { offeringId: true } } },
      },
      staff: {
        where: { isDeleted: false, homeExpert: null },
        select: { id: true, speciality: true, user: { select: { gender: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

type SalonRow = Awaited<ReturnType<typeof loadSalons>>[number];

type SidePlan = {
  side: HomeAudience;
  /** Live offerings already on this side; empty → a menu is created. */
  existingOfferingIds: string[];
  /** Salon staff who become experts. */
  fromStaff: { id: string; speciality: string | null }[];
  /** Home-only staff members to create. */
  newStaff: number;
};

type SalonPlan = { salon: SalonRow; sides: SidePlan[]; createProfile: boolean; updateProfile: boolean };

type Skip = { salon: SalonRow; why: string };

const planFor = (salon: SalonRow): SalonPlan | Skip => {
  if (salon.latitude == null || salon.longitude == null) return { salon, why: "no map pin" };
  const p = salon.homeProfile;
  if (p?.status === HomeServiceStatus.SUSPENDED) return { salon, why: "home profile suspended by an admin" };
  if (p?.status === HomeServiceStatus.REJECTED) return { salon, why: "home profile rejected by an admin" };

  const sides = allowedSidesOf(salon.audience).map((side): SidePlan => {
    const offerings = salon.homeOfferings.filter((o) => o.audience === side).map((o) => o.id);
    const bookable = salon.homeExperts.filter((e) => e.audience === side && e.offerings.length > 0).length;
    if (offerings.length && bookable >= 1) return { side, existingOfferingIds: offerings, fromStaff: [], newStaff: 0 };
    const gender = genderOf(side);
    const fromStaff = salon.staff
      .filter((st) => st.user.gender === gender)
      .slice(0, MAX_EXPERTS_PER_SIDE)
      .map(({ id, speciality }) => ({ id, speciality }));
    return { side, existingOfferingIds: offerings, fromStaff, newStaff: Math.max(0, MIN_EXPERTS - bookable - fromStaff.length) };
  });

  const enabled = (side: HomeAudience) => (side === HomeAudience.LADIES ? p?.ladiesEnabled : p?.gentsEnabled);
  const updateProfile =
    !!p &&
    (!p.isOn || p.status !== HomeServiceStatus.ACTIVE || sides.some((s) => !enabled(s.side)));
  const work = !p || updateProfile || sides.some((s) => !s.existingOfferingIds.length || s.fromStaff.length || s.newStaff);
  if (!work) return { salon, sides: [], createProfile: false, updateProfile: false };
  return { salon, sides, createProfile: !p, updateProfile };
};

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function seed() {
  const now = new Date();
  const [salons, flags] = await Promise.all([loadSalons(), loadHomeFlags()]);
  const plans: SalonPlan[] = [];
  const skips: Skip[] = [];
  for (const s of salons) {
    const plan = planFor(s);
    if ("why" in plan) skips.push(plan);
    else plans.push(plan);
  }
  const todo = plans.filter((p) => p.sides.length);
  const done = plans.length - todo.length;

  const byAudience = (a: string) => salons.filter((s) => s.audience === a).length;
  const sideCount = (side: HomeAudience) => plans.filter((p) => allowedSidesOf(p.salon.audience).includes(side)).length;
  const sum = (f: (s: SidePlan) => number) => todo.reduce((n, p) => n + p.sides.reduce((m, s) => m + f(s), 0), 0);

  console.log(
    `${salons.length} active salons (Ladies ${byAudience("LADIES")}, Gents ${byAudience("GENTS")}, Unisex ${byAudience("UNISEX")})`,
  );
  console.log(
    `  → Home Service on ${plans.length}: Ladies side ${sideCount(HomeAudience.LADIES)}, Gents side ${sideCount(HomeAudience.GENTS)}` +
      ` · ${done} already complete, ${todo.length} to write`,
  );
  console.log(
    `  profiles: ${todo.filter((p) => p.createProfile).length} new, ${todo.filter((p) => p.updateProfile).length} switched on / sides added` +
      ` · menus: ${sum((s) => (s.existingOfferingIds.length ? 0 : 1))} new` +
      ` · experts: ${sum((s) => s.fromStaff.length)} from salon staff, ${sum((s) => s.newStaff)} new home-only staff`,
  );
  if (skips.length) {
    console.log(`  skipped ${skips.length}:`);
    for (const k of skips.slice(0, 20)) console.log(`    ${k.salon.name} (${k.salon.area}) — ${k.why}`);
    if (skips.length > 20) console.log(`    … and ${skips.length - 20} more`);
  }
  const paused = plans.filter((p) => p.salon.bookingPause !== BookingPause.NONE || (p.salon.homeProfile?.pausedUntil ?? 0) > now);
  if (paused.length) console.log(`  note: ${paused.length} of them are paused (salon bookings or home visits) and will not take bookings until resumed`);
  if (!flags.enabled || !flags.ladiesEnabled || !flags.gentsEnabled) {
    console.log(
      `  note: platform flags — Home Service ${flags.enabled ? "on" : "OFF"}, Ladies ${flags.ladiesEnabled ? "on" : "OFF"}, Gents ${flags.gentsEnabled ? "on" : "OFF"}.` +
        " Turn them on in admin Settings → Flags, or no side that is off can be booked.",
    );
  }

  if (!apply) {
    for (const p of todo.slice(0, 15)) {
      const sides = p.sides.map((s) => `${s.side}${s.newStaff ? ` +${s.newStaff} new` : ""}`).join(", ");
      console.log(`  ${p.salon.area.padEnd(18)} ${p.salon.name} [${p.salon.audience}: ${sides}]`);
    }
    if (todo.length > 15) console.log(`  … and ${todo.length - 15} more`);
    console.log("Dry run. Re-run with -- --apply to write.");
    return;
  }

  let offerings = 0;
  let experts = 0;
  let newStaff = 0;
  for (const [n, plan] of todo.entries()) {
    const s = plan.salon;
    const sides = allowedSidesOf(s.audience);
    await prisma.$transaction(
      async (tx) => {
        if (plan.createProfile) {
          await tx.homeServiceProfile.create({
            data: {
              salonId: s.id,
              isOn: true,
              ladiesEnabled: sides.includes(HomeAudience.LADIES),
              gentsEnabled: sides.includes(HomeAudience.GENTS),
              status: HomeServiceStatus.ACTIVE,
              everApproved: true,
              radiusKm: 6 + Math.round(rand(`${s.id}:r`) * 4),
              travelFeeMinor: 0,
              minOrderMinor: 30000,
              statusReason: MARK,
              reviewedAt: now,
            },
          });
        } else if (plan.updateProfile) {
          await tx.homeServiceProfile.update({
            where: { salonId: s.id },
            data: {
              isOn: true,
              ...(sides.includes(HomeAudience.LADIES) ? { ladiesEnabled: true } : {}),
              ...(sides.includes(HomeAudience.GENTS) ? { gentsEnabled: true } : {}),
              status: HomeServiceStatus.ACTIVE,
              everApproved: true,
              reviewedAt: now,
            },
          });
        }

        for (const sp of plan.sides) {
          let offeringIds = sp.existingOfferingIds;
          if (!offeringIds.length) {
            const rows = await tx.homeServiceOffering.createManyAndReturn({
              data: menuFor(s.id, sp.side).map((m) => ({
                salonId: s.id,
                audience: sp.side,
                category: m.category,
                name: m.name,
                description: m.description,
                kitNote: m.kitNote,
                durationMin: m.durationMin,
                priceMinor: m.priceMinor,
                sortOrder: m.sortOrder,
                images: [],
              })),
              select: { id: true },
            });
            offeringIds = rows.map((r) => r.id);
            offerings += rows.length;
          }

          const gender = genderOf(sp.side);
          const staff = [...sp.fromStaff];
          if (sp.newStaff) {
            const users: Prisma.UserCreateManyInput[] = [];
            const rows: Prisma.StaffCreateManyInput[] = [];
            for (let i = 0; i < sp.newStaff; i++) {
              const seed = `${s.id}:${sp.side}:${i}`;
              const names = EXPERT_NAMES[sp.side];
              const userId = randomUUID();
              const staffId = randomUUID();
              users.push({
                id: userId,
                name: names[Math.floor(rand(seed) * names.length)],
                email: `${EXPERT_EMAIL_PREFIX}${s.id}.${sp.side.toLowerCase()}.${i}@${SEED_DOMAIN}`,
                role: UserRole.STAFF,
                status: UserStatus.ACTIVE,
                gender,
                phone: phoneFor(seed),
                emailVerified: true,
                emailVerifiedAt: now,
                isTest: true,
              });
              const speciality = sp.side === HomeAudience.LADIES ? "Home beauty expert" : "Home grooming expert";
              rows.push({ id: staffId, userId, salonId: s.id, speciality, experience: 2 + Math.floor(rand(`${seed}:x`) * 8) });
              staff.push({ id: staffId, speciality });
            }
            await tx.user.createMany({ data: users });
            await tx.staff.createMany({ data: rows });
            newStaff += rows.length;
          }

          if (!staff.length) continue;
          const expertRows = staff.map((st) => ({
            id: randomUUID(),
            staffId: st.id,
            salonId: s.id,
            gender,
            audience: sp.side,
            verification: ExpertVerification.VERIFIED,
            submittedAt: now,
            verifiedAt: now,
            headline: headlineFor(sp.side, st.speciality),
            languages: ["Bangla", "English"],
            completedJobs: Math.round(rand(`${st.id}:jobs`) * 60),
          }));
          await tx.homeExpert.createMany({ data: expertRows });
          await tx.homeExpertOffering.createMany({
            data: expertRows.flatMap((e, i) => linksFor(offeringIds, i).map((offeringId) => ({ expertId: e.id, offeringId }))),
            skipDuplicates: true,
          });
          experts += expertRows.length;
        }
      },
      { timeout: 60_000, maxWait: 20_000 },
    );
    if ((n + 1) % 50 === 0) console.log(`  ${n + 1}/${todo.length} salons…`);
  }
  console.log(
    `Wrote ${todo.length} salons: ${offerings} offerings, ${experts} verified experts (${newStaff} of them new home-only staff).`,
  );
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

async function unseed() {
  const expertUsers = {
    email: { startsWith: EXPERT_EMAIL_PREFIX, endsWith: `@${SEED_DOMAIN}` },
    // A salon appointment points at the staff row; leave those people in place.
    staff: { appointments: { none: {} } },
  } satisfies Prisma.UserWhereInput;

  const [profiles, users] = await Promise.all([
    prisma.homeServiceProfile.findMany({
      where: { statusReason: MARK },
      select: { salonId: true, salon: { select: { _count: { select: { homeBookings: true } } } } },
    }),
    prisma.user.findMany({
      where: expertUsers,
      select: { id: true, staff: { select: { salon: { select: { _count: { select: { homeBookings: true } } } } } } },
    }),
  ]);
  const busy = profiles.filter((p) => p.salon._count.homeBookings > 0).map((p) => p.salonId);
  const ids = profiles.map((p) => p.salonId).filter((id) => !busy.includes(id));
  const userIds = users.filter((u) => !u.staff?.salon._count.homeBookings).map((u) => u.id);
  console.log(
    `${profiles.length} seeded branches; removing ${ids.length}, keeping ${busy.length} with home bookings. ` +
      `${userIds.length} home-only staff to remove.`,
  );
  if (!apply && !remove) return;

  // Home-only staff first (staff and expert rows cascade), then the experts,
  // menus (their links cascade) and profiles of the seeded branches.
  const u = await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  const e = await prisma.homeExpert.deleteMany({ where: { salonId: { in: ids } } });
  const o = await prisma.homeServiceOffering.deleteMany({ where: { salonId: { in: ids } } });
  const p = await prisma.homeServiceProfile.deleteMany({ where: { salonId: { in: ids }, statusReason: MARK } });
  console.log(`Removed ${p.count} profiles, ${o.count} offerings, ${e.count} experts, ${u.count} home-only staff.`);
}

(async () => {
  // The .env database only when asked for by name.
  if ((apply || remove) && !onHomeBranch && !process.argv.includes("--env-db")) {
    console.error("Refusing to write: no test branch found. Pass -- --env-db to write to the .env database.");
    process.exit(1);
  }
  try {
    await (remove ? unseed() : seed());
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
