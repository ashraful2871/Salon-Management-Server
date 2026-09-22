/**
 * What the in-chat booking assistant could actually offer today - against the
 * real database. The assistant can only sell what a salon has listed, so this
 * reports, per ACTIVE salon, whether it has services, counters and free slots,
 * and ends with the list of what to chase with owners.
 *
 *   npm run assistant:check
 *
 * Read-only: two queries, no writes, no Gemini. Always exits 0 - it is a
 * report, not a gate.
 */
import "../config";
import prisma from "../app/shared/prisma";

/** Matches what the assistant will offer in phase 2, so the window is honest. */
const DAYS = Number(process.env.ASSISTANT_MAX_DAYS) || 14;

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

const main = async () => {
  // Slot.date is normalised to UTC midnight by toCalendarDate in slot.service.ts,
  // so the window has to be built the same way - never from a local-time `new Date()`.
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const horizon = new Date(today);
  horizon.setUTCDate(horizon.getUTCDate() + DAYS);

  const salons = await prisma.salon.findMany({
    where: { status: "ACTIVE", isDeleted: false },
    select: {
      id: true,
      name: true,
      area: true,
      latitude: true,
      longitude: true,
      locationAccuracy: true,
      operatingHours: true,
      _count: {
        select: {
          services: { where: { isActive: true, isDeleted: false } },
          counters: { where: { isActive: true, isDeleted: false } },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  console.log(
    `Assistant readiness - ${plural(salons.length, "active salon")} · ` +
      `free-slot window ${isoDay(today)} -> ${isoDay(horizon)} (${DAYS} days)\n`,
  );

  if (!salons.length) {
    console.log("No ACTIVE salons. Nothing for the assistant to offer yet.");
    await prisma.$disconnect();
    process.exit(0);
  }

  // One row per salon per day, so the same query yields both the slot count
  // and how many distinct days those slots spread over.
  const slotDays = await prisma.slot.groupBy({
    by: ["salonId", "date"],
    where: {
      salonId: { in: salons.map((salon) => salon.id) },
      status: "AVAILABLE",
      isBooked: false,
      date: { gte: today, lt: horizon },
    },
    _count: { _all: true },
  });

  const freeSlots = new Map<string, { slots: number; days: number }>();
  for (const row of slotDays) {
    const stat = freeSlots.get(row.salonId) ?? { slots: 0, days: 0 };
    stat.slots += row._count._all;
    stat.days += 1;
    freeSlots.set(row.salonId, stat);
  }

  const toFix = {
    services: [] as string[],
    counters: [] as string[],
    slots: [] as string[],
    pin: [] as string[],
    approximatePin: [] as string[],
    hours: [] as string[],
  };
  let bookable = 0;

  const width = Math.min(
    34,
    salons.reduce((max, salon) => Math.max(max, salon.name.length), 0),
  );

  for (const salon of salons) {
    const services = salon._count.services;
    const counters = salon._count.counters;
    const { slots, days } = freeSlots.get(salon.id) ?? { slots: 0, days: 0 };
    const hasPin = salon.latitude !== null && salon.longitude !== null;
    const hasHours = salon.operatingHours !== null && salon.operatingHours !== undefined;
    const canBook = services >= 1 && counters >= 1 && slots >= 1;

    if (canBook) bookable += 1;

    const where = `${salon.name} (${salon.area})`;
    if (services < 1) toFix.services.push(where);
    if (counters < 1) toFix.counters.push(where);
    if (slots < 1) toFix.slots.push(where);
    if (!hasPin) toFix.pin.push(where);
    else if (salon.locationAccuracy === "APPROXIMATE") toFix.approximatePin.push(where);
    if (!hasHours) toFix.hours.push(where);

    console.log(
      `  ${canBook ? "✓" : "✗"} ${salon.name.padEnd(width)} — ` +
        `${plural(services, "service")} · ${plural(counters, "counter")} · ` +
        `${plural(slots, "slot")} over ${plural(days, "day")} · ` +
        `${hasPin ? `${salon.locationAccuracy ?? "UNKNOWN"} pin` : "no pin"} · ` +
        `${hasHours ? "hours" : "no hours"}`,
    );
  }

  console.log(
    `\n${bookable} of ${salons.length} active salons could take a booking ` +
      `through the chat today.`,
  );
  console.log(
    `  (needs at least one active service, one active counter and one free ` +
      `slot in the next ${DAYS} days)`,
  );

  const groups: { label: string; why: string; salons: string[] }[] = [
    {
      label: "No active services",
      why: "the chat has nothing to price or book",
      salons: toFix.services,
    },
    {
      label: "No active counters",
      why: "a booking needs a counterId, so the funnel dead-ends",
      salons: toFix.counters,
    },
    {
      label: `No free slots in the next ${DAYS} days`,
      why: "owner must run POST /slots/bulk-create",
      salons: toFix.slots,
    },
    {
      label: "No map pin",
      why: "invisible to \"salons near me\"",
      salons: toFix.pin,
    },
    {
      label: "Approximate pin only",
      why: "distances and directions will be off",
      salons: toFix.approximatePin,
    },
    {
      label: "No operating hours",
      why: "the chat cannot say when they are open",
      salons: toFix.hours,
    },
  ].filter((group) => group.salons.length > 0);

  if (!groups.length) {
    console.log("\nTO FIX\n  Nothing - every active salon is ready.");
  } else {
    console.log("\nTO FIX");
    for (const group of groups) {
      console.log(`\n  ${group.label} (${group.salons.length}) - ${group.why}`);
      group.salons.forEach((name) => console.log(`    · ${name}`));
    }
  }

  await prisma.$disconnect();
  process.exit(0);
};

main().catch(async (error) => {
  console.error("\nassistant:check could not finish:");
  console.error(error);
  await prisma.$disconnect();
  // Exit 0 by design: this is a report, never a build gate.
  process.exit(0);
});
