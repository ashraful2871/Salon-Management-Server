/**
 * Test data for the daily close page and checkout v2 (owner Phase 14), for ONE
 * branch. Dry run by default; nothing is written without --apply.
 *
 *   npm run seed:close -- --salon-name "Modern Men's Salon"          # dry run
 *   npm run seed:close -- --salon <salonId> --apply                   # write
 *   npm run seed:close -- --salon <salonId> --remove [--apply]        # take it out
 *
 * What --apply writes (all walk-ins of one test customer, notes "[test] seed:close"):
 *   Today   - 4 bookings completed through the real checkout:
 *               ৳450 cash, ৳50 discount + ৳40 tip  → ৳440 cash
 *               ৳800 cash                           → ৳800 cash
 *               ৳1,200 card + ৳100 tip              → ৳1,300 card
 *               ৳300 mobile banking                 → ৳300 mobile
 *             expected today: cash ৳1,240 · card ৳1,300 · mobile ৳300 · tips ৳140
 *           - 2 bookings left CHECKED_IN (৳650, ৳500) to try the tip / discount
 *             rows in the checkout dialog yourself.
 *   Past    - days −1…−5: two paid walk-ins a day; days −1…−4 already closed
 *             (balanced, short ৳150, over ৳20, short ৳50); day −5 left open so a
 *             past day can be closed from the date picker.
 *
 * Walk-ins with no deposit write no ledger rows while booking.commissionOnDirect
 * is off (the script refuses otherwise), so balances, payouts and dues are untouched.
 * --remove deletes the marked bookings (payments cascade) and every close of
 * this branch in the last 6 days (including one you submitted while testing).
 */
import "../config"; // loads .env
import { AppointmentSource, AppointmentStatus, PaymentMethod, PaymentStatus } from "@prisma/client";
import prisma from "../app/shared/prisma";
import { getSetting } from "../app/utils/settings";
import { formatBDT } from "../app/utils/money";
import { AppointmentCheckout } from "../app/modules/Appointment/appointment.checkout";
import { addDays, dayStart, dhakaDay } from "../app/modules/Analytics/analytics.days";

const MARK = "[test] seed:close";
const CUSTOMER_EMAIL = "daily-close-test@seed.example.com";
const HOUR = 60 * 60 * 1000;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = flag("--apply");
const remove = flag("--remove");

const resolveSalon = async () => {
  const id = value("--salon");
  const name = value("--salon-name");
  if (!id && !name) throw new Error('Pass --salon <id> or --salon-name "<name>"');
  const salons = await prisma.salon.findMany({
    where: id ? { id, isDeleted: false } : { name: { equals: name, mode: "insensitive" }, isDeleted: false },
    select: {
      id: true,
      name: true,
      owner: { select: { userId: true, user: { select: { email: true } } } },
    },
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

const run = async () => {
  const salon = await resolveSalon();
  const today = dhakaDay();
  const days = [0, 1, 2, 3, 4, 5].map((n) => addDays(today, -n));
  console.log(`branch: ${salon.name} (${salon.id}), owner ${salon.owner.user.email}; today ${today} (Dhaka)`);

  const existing = await prisma.appointment.findMany({
    where: { salonId: salon.id, notes: MARK },
    select: { id: true },
  });
  const closes = await prisma.dailyClose.findMany({
    where: { salonId: salon.id, date: { gte: new Date(`${days[5]}T00:00:00Z`) } },
    select: { id: true, date: true, differenceMinor: true },
  });

  if (remove) {
    console.log(`remove: ${existing.length} test booking(s), ${closes.length} close(s) since ${days[5]}`);
    for (const c of closes) console.log(`  close ${c.date.toISOString().slice(0, 10)} diff ${formatBDT(c.differenceMinor)}`);
    if (!apply) return console.log("dry run - add --apply to delete");
    const ids = existing.map((a) => a.id);
    await prisma.$transaction([
      prisma.ledgerEntry.deleteMany({ where: { appointmentId: { in: ids } } }),
      prisma.appointment.deleteMany({ where: { id: { in: ids } } }),
      prisma.dailyClose.deleteMany({ where: { id: { in: closes.map((c) => c.id) } } }),
    ]);
    return console.log("removed");
  }

  if (existing.length > 0) {
    throw new Error(`Already seeded (${existing.length} test bookings). Run with --remove --apply first.`);
  }
  if (await getSetting("booking.commissionOnDirect")) {
    throw new Error("booking.commissionOnDirect is on: test walk-ins would be commissioned. Not seeding.");
  }
  if (closes.length > 0) {
    throw new Error(`This branch already has ${closes.length} close(s) since ${days[5]}; seeding would collide.`);
  }

  const [service, counter] = await Promise.all([
    prisma.service.findFirst({ where: { salonId: salon.id }, select: { id: true, name: true } }),
    prisma.counter.findFirst({ where: { salonId: salon.id }, select: { id: true, name: true } }),
  ]);
  if (!service || !counter) throw new Error("The branch needs at least one service and one counter");

  console.log(`service "${service.name}", counter "${counter.name}"`);
  console.log("today: 4 completed via checkout (cash ৳1,240 · card ৳1,300 · mobile ৳300 · tips ৳140) + 2 checked in (৳650, ৳500)");
  console.log(`past: ${days.slice(1).join(", ")} - 2 paid walk-ins each; closes on the first 4, ${days[5]} left open`);
  if (!apply) return console.log("dry run - add --apply to write");

  const customer = await prisma.user.upsert({
    where: { email: CUSTOMER_EMAIL },
    update: {},
    create: { email: CUSTOMER_EMAIL, name: "Till Test Customer", isTest: true },
  });

  const walkIn = (day: string, startTime: string, totalMinor: number, status: AppointmentStatus, at: Date) =>
    prisma.appointment.create({
      data: {
        customerId: customer.id,
        salonId: salon.id,
        serviceId: service.id,
        counterId: counter.id,
        appointmentDate: new Date(`${day}T00:00:00Z`),
        startTime,
        status,
        totalMinor,
        source: AppointmentSource.SALON_DIRECT,
        notes: MARK,
        checkedInAt: at,
        checkedInById: salon.owner.userId,
        ...(status === AppointmentStatus.COMPLETED && { completedAt: at, completedById: salon.owner.userId }),
      },
    });

  // ---- today, through the real checkout (tip, discount, commission rules)
  const now = new Date();
  const actor = { userId: salon.owner.userId, role: "SALON_OWNER" };
  const todayRuns: Array<[string, number, Parameters<typeof AppointmentCheckout.checkout>[2] | null]> = [
    ["10:00", 45000, { paymentMethod: "CASH", tipMinor: 4000, discountMinor: 5000, discountReason: "Regular customer (test)" }],
    ["10:30", 80000, { paymentMethod: "CASH" }],
    ["11:00", 120000, { paymentMethod: "CARD", reference: "TEST-SLIP-1", tipMinor: 10000 }],
    ["11:30", 30000, { paymentMethod: "MOBILE_BANKING", reference: "TEST-TRX-1" }],
    ["12:00", 65000, null],
    ["12:30", 50000, null],
  ];
  for (const [time, total, payload] of todayRuns) {
    const a = await walkIn(today, time, total, AppointmentStatus.CHECKED_IN, now);
    if (payload) await AppointmentCheckout.checkout(actor, a.id, payload);
  }

  // ---- past days: payments dated 14:00 Dhaka that day
  const pastBills: Array<[number, PaymentMethod]> = [
    [70000, PaymentMethod.CASH],
    [40000, PaymentMethod.CARD],
  ];
  const differences = [0, -15000, 2000, -5000];
  for (const [i, day] of days.slice(1).entries()) {
    const at = new Date(dayStart(day).getTime() + 8 * HOUR);
    let cash = 0;
    let card = 0;
    for (const [j, [bill, method]] of pastBills.entries()) {
      const a = await walkIn(day, j === 0 ? "13:00" : "14:00", bill + i * 5000, AppointmentStatus.COMPLETED, at);
      await prisma.payment.create({
        data: {
          appointmentId: a.id,
          amountMinor: a.totalMinor,
          paymentMethod: method,
          status: PaymentStatus.COMPLETED,
          paymentDate: at,
        },
      });
      if (method === PaymentMethod.CASH) cash += a.totalMinor;
      else card += a.totalMinor;
    }
    if (i < differences.length) {
      await prisma.dailyClose.create({
        data: {
          salonId: salon.id,
          date: new Date(`${day}T00:00:00Z`),
          expectedCashMinor: cash,
          countedCashMinor: cash + differences[i],
          cardMinor: card,
          mobileMinor: 0,
          differenceMinor: differences[i],
          note: differences[i] === 0 ? MARK : `${MARK} - counted ${differences[i] < 0 ? "short" : "over"}`,
          closedById: salon.owner.userId,
          createdAt: new Date(at.getTime() + 8 * HOUR),
        },
      });
    }
  }
  console.log("seeded. Open /dashboard/close with this branch selected.");
};

run()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
