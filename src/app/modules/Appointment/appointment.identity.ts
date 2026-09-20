import { Prisma } from "@prisma/client";

/**
 * What the customer is called at the counter.
 *
 * Two identifiers, because they answer different questions. The `token` is
 * global and unguessable-ish - it is what a customer reads off their phone to
 * prove which booking is theirs. The `serialNumber` is local to one salon, one
 * service and one day, and it is the queue position: #1 goes in before #2.
 */

/**
 * No O/0 and no I/1. A token is read aloud across a counter, so the pairs that
 * sound or look alike are simply not in the alphabet.
 */
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 5;
const TOKEN_ATTEMPTS = 5;

const randomToken = () => {
  let body = "";
  for (let i = 0; i < TOKEN_LENGTH; i += 1) {
    body += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  }
  return `TKN-${body}`;
};

/**
 * 32^5 is ~33 million, so a collision is already unlikely; checking anyway
 * keeps the unique index from turning one into a failed booking.
 */
export const generateToken = async (
  db: Prisma.TransactionClient,
): Promise<string> => {
  for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
    const token = randomToken();
    const taken = await db.appointment.findUnique({
      where: { token },
      select: { id: true },
    });
    if (!taken) return token;
  }

  // Five collisions in a row is not chance, so stop guessing and make it unique
  // by construction rather than handing the customer an error.
  return `TKN-${Date.now().toString(36).toUpperCase().slice(-6)}`;
};

/** Local midnight either side of the appointment's day. */
export const dayBounds = (date: Date) => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
};

const queueKey = (salonId: string, serviceId: string, start: Date) =>
  `${salonId}:${serviceId}:${start.toDateString()}`;

/**
 * The next place in the queue for this salon + service + day.
 *
 * The advisory lock is the whole point: reading the current maximum and then
 * inserting is a classic race, and under Prisma's default read-committed
 * isolation two simultaneous bookings would both read the same number and both
 * claim it. The lock is transaction-scoped, so it is released on commit or
 * rollback without any cleanup, and it only serialises bookings for the same
 * queue - two different services still book in parallel.
 */
export const nextSerialNumber = async (
  tx: Prisma.TransactionClient,
  appointment: { salonId: string; serviceId: string; appointmentDate: Date },
): Promise<number> => {
  const { start, end } = dayBounds(appointment.appointmentDate);

  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${queueKey(appointment.salonId, appointment.serviceId, start)}),
      0
    )
  `;

  const last = await tx.appointment.findFirst({
    where: {
      salonId: appointment.salonId,
      serviceId: appointment.serviceId,
      appointmentDate: { gte: start, lt: end },
      // Bookings made before serial numbers existed have none; ordering by a
      // column full of NULLs would otherwise hand out #1 forever.
      serialNumber: { not: null },
    },
    orderBy: { serialNumber: "desc" },
    select: { serialNumber: true },
  });

  return (last?.serialNumber ?? 0) + 1;
};

export const AppointmentIdentity = {
  generateToken,
  nextSerialNumber,
  dayBounds,
};
