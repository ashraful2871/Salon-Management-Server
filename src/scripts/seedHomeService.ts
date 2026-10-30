/**
 * Home Service demo data on the Neon test branch: some salons in every Dhaka
 * area serve Home Service, with a Ladies and/or Gents menu and their own
 * staff (matching gender) as verified experts, so the public pages have
 * something to list.
 *
 *   npm run seed:home                 dry run: which salons, how many rows
 *   npm run seed:home -- --apply      write it to the test branch
 *   npm run seed:home -- --remove     delete what --apply wrote
 *   add --env-db to any of them for the .env database (production)
 *
 * Everything written is marked with `statusReason = MARK` on the branch's
 * profile; --remove deletes only marked branches, and skips any that already
 * have a home booking (bookings are Restrict, and are someone's test data).
 * Experts get no rating or reviews (no Review rows would back them).
 */
import { onHomeBranch } from "./homeBranchEnv"; // first: picks the database
import "../config";
import { createHash } from "crypto";
import { Gender, HomeAudience, HomeCategory, SalonStatus } from "@prisma/client";
import prisma from "../app/shared/prisma";
import { allowedSidesOf } from "../app/modules/HomeService/home.owner";

const MARK = "seed:home-demo";
const PER_AREA = 2;
const EXPERTS_PER_SIDE = 3;

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

async function pickSalons() {
  const salons = await prisma.salon.findMany({
    where: {
      status: SalonStatus.ACTIVE,
      isDeleted: false,
      latitude: { not: null },
      longitude: { not: null },
      homeProfile: null,
    },
    select: {
      id: true,
      name: true,
      area: true,
      audience: true,
      isTest: true,
      staff: {
        where: { isDeleted: false, homeExpert: null },
        select: { id: true, speciality: true, user: { select: { gender: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  // Each salon's sides that it has staff of the right gender for.
  const usable = salons
    .map((s) => {
      const sides = allowedSidesOf(s.audience).filter((side) =>
        s.staff.some((st) => st.user.gender === (side === HomeAudience.LADIES ? Gender.FEMALE : Gender.MALE)),
      );
      return { ...s, sides };
    })
    .filter((s) => s.sides.length > 0);

  // Up to PER_AREA per area, deterministic but mixed: a Ladies branch first
  // (Ladies leads everywhere), then a Gents one, then whatever is left.
  const byArea = new Map<string, typeof usable>();
  for (const s of usable) byArea.set(s.area, [...(byArea.get(s.area) ?? []), s]);
  const picked: typeof usable = [];
  for (const list of byArea.values()) {
    const shuffled = [...list].sort((a, b) => rand(a.id) - rand(b.id));
    const area: typeof usable = [];
    for (const side of [HomeAudience.LADIES, HomeAudience.GENTS]) {
      const s = shuffled.find((x) => x.sides.includes(side) && !area.includes(x));
      if (s && area.length < PER_AREA) area.push(s);
    }
    for (const s of shuffled) if (area.length < PER_AREA && !area.includes(s)) area.push(s);
    picked.push(...area);
  }
  return { picked, total: salons.length, areas: byArea.size };
}

async function seed() {
  const { picked, total, areas } = await pickSalons();
  const ladies = picked.filter((s) => s.sides.includes(HomeAudience.LADIES)).length;
  const gents = picked.filter((s) => s.sides.includes(HomeAudience.GENTS)).length;
  const test = picked.filter((s) => s.isTest).length;
  console.log(
    `${total} active salons without Home Service · ${areas} areas → ${picked.length} branches (Ladies ${ladies}, Gents ${gents}; ${test} are isTest and show only to test customers)`,
  );
  if (!apply) {
    for (const s of picked.slice(0, 15)) console.log(`  ${s.area.padEnd(18)} ${s.name} [${s.sides.join(", ")}]`);
    if (picked.length > 15) console.log(`  … and ${picked.length - 15} more`);
    console.log("Dry run. Re-run with -- --apply to write.");
    return;
  }

  const now = new Date();
  let offerings = 0;
  let experts = 0;
  for (const s of picked) {
    await prisma.$transaction(async (tx) => {
      await tx.homeServiceProfile.create({
        data: {
          salonId: s.id,
          isOn: true,
          ladiesEnabled: s.sides.includes(HomeAudience.LADIES),
          gentsEnabled: s.sides.includes(HomeAudience.GENTS),
          status: "ACTIVE",
          everApproved: true,
          radiusKm: 6 + Math.round(rand(`${s.id}:r`) * 4),
          travelFeeMinor: 0,
          minOrderMinor: 30000,
          statusReason: MARK,
          reviewedAt: now,
        },
      });

      for (const side of s.sides) {
        const menu = menuFor(s.id, side);
        const rows = await tx.homeServiceOffering.createManyAndReturn({
          data: menu.map((m) => ({
            salonId: s.id,
            audience: side,
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
        offerings += rows.length;

        const gender = side === HomeAudience.LADIES ? Gender.FEMALE : Gender.MALE;
        const staff = s.staff.filter((st) => st.user.gender === gender).slice(0, EXPERTS_PER_SIDE);
        for (const [i, st] of staff.entries()) {
          const expert = await tx.homeExpert.create({
            data: {
              staffId: st.id,
              salonId: s.id,
              gender,
              audience: side,
              verification: "VERIFIED",
              submittedAt: now,
              verifiedAt: now,
              headline:
                st.speciality ??
                (side === HomeAudience.LADIES ? "Facials, threading and party looks at home" : "Haircuts and grooming at home"),
              languages: ["Bangla", "English"],
              completedJobs: Math.round(rand(`${st.id}:jobs`) * 60),
            },
            select: { id: true },
          });
          experts += 1;
          // Every expert does the first two; the rest is split so menus differ.
          const links = rows.filter((_, j) => j < 2 || (j + i) % 3 !== 0);
          await tx.homeExpertOffering.createMany({
            data: links.map((o) => ({ expertId: expert.id, offeringId: o.id })),
          });
        }
      }
    }, { timeout: 60_000, maxWait: 20_000 }); // ~20 round trips to Neon per branch
  }
  console.log(`Wrote ${picked.length} profiles, ${offerings} offerings, ${experts} verified experts.`);
}

async function unseed() {
  const profiles = await prisma.homeServiceProfile.findMany({
    where: { statusReason: MARK },
    select: { salonId: true, salon: { select: { _count: { select: { homeBookings: true } } } } },
  });
  const busy = profiles.filter((p) => p.salon._count.homeBookings > 0).map((p) => p.salonId);
  const ids = profiles.map((p) => p.salonId).filter((id) => !busy.includes(id));
  console.log(`${profiles.length} seeded branches; removing ${ids.length}, keeping ${busy.length} with home bookings.`);
  if (!apply && !remove) return;

  // Experts first (their offering links cascade), then the menus, then the profiles.
  const e = await prisma.homeExpert.deleteMany({ where: { salonId: { in: ids } } });
  const o = await prisma.homeServiceOffering.deleteMany({ where: { salonId: { in: ids } } });
  const p = await prisma.homeServiceProfile.deleteMany({ where: { salonId: { in: ids }, statusReason: MARK } });
  console.log(`Removed ${p.count} profiles, ${o.count} offerings, ${e.count} experts.`);
}

(async () => {
  // The .env database (production) only when asked for by name.
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
