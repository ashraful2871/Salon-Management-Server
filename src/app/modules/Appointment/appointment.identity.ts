import { Prisma } from "@prisma/client";

/**
 * What the customer is called at the counter.
 *
 * Two identifiers, because they answer different questions. The `token` is
 * global and unguessable-ish - it is what a customer reads off their phone to
 * prove which booking is theirs. The `serialNumber` is local to one salon,
 * service, counter and day, and it is the queue position: #1 goes in before #2.
 * It is the slot's position in that day, not the order people booked in, so
 * whoever takes the 11:00 slot is #5 even if they booked first.
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

/**
 * The serial for whoever books this slot: its place in the day for the same
 * salon + service + counter.
 *
 * No lock is needed. The number belongs to the slot, not to the order of
 * bookings, and the atomic slot claim already guarantees one booking per slot.
 * Slots made before numbering existed have no `sequenceNo`, so their position
 * is counted from the earlier slots of that day instead.
 *
 * Call it after the slot is claimed in the same transaction. The number is
 * re-read rather than taken from `slot`, which may have been loaded before a
 * bulk create renumbered the day; the claim's row lock makes this read final.
 */
export const slotPosition = async (
  tx: Prisma.TransactionClient,
  slot: {
    id: string;
    salonId: string;
    serviceId: string | null;
    counterId: string | null;
    date: Date;
    startTime: string;
  },
): Promise<number> => {
  const current = await tx.slot.findUnique({
    where: { id: slot.id },
    select: { sequenceNo: true },
  });
  if (current?.sequenceNo != null) return current.sequenceNo;

  // "HH:mm" is zero-padded, so a string comparison is a time comparison.
  const earlier = await tx.slot.count({
    where: {
      salonId: slot.salonId,
      serviceId: slot.serviceId,
      counterId: slot.counterId,
      date: slot.date,
      startTime: { lt: slot.startTime },
    },
  });

  return earlier + 1;
};

export const AppointmentIdentity = {
  generateToken,
  slotPosition,
};
