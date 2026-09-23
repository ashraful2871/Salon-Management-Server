import bcrypt from "bcryptjs";
import { createHmac, randomBytes } from "crypto";
import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import {
  AppointmentSource,
  AppointmentStatus,
  BookingChannel,
  DepositStatus,
  Prisma,
  SalonStatus,
  Slot,
  UserRole,
} from "@prisma/client";
import { sendEmail } from "../../utils/emailSender";
import {
  getBookingConfirmationTemplate,
  getNewBookingOwnerTemplate,
} from "../../utils/emailTemplates";
import { formatBDT } from "../../utils/money";
import { assertCanActOnAppointment } from "../../utils/salonAccess";
import { hasSlotStarted } from "../../utils/slotTime";
import { WalletService } from "../Wallet/wallet.service";
import { withPaymentSummary } from "./appointment.billing";
import {
  AppointmentCheckout,
  appointmentDetailInclude,
} from "./appointment.checkout";
import { AppointmentDeposit } from "./appointment.deposit";
import { AppointmentIdentity } from "./appointment.identity";

/**
 * Which status each status may move to. Terminal states go nowhere.
 *
 * Two edges carry extra conditions, checked in `updateAppointmentStatus`:
 * CHECKED_IN -> CANCELLED is the salon's or an admin's call only, and
 * IN_PROGRESS -> NO_SHOW is only for legacy rows the old auto-start job moved
 * without a check-in - a customer who was checked in cannot be a no-show.
 */
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  PENDING: [AppointmentStatus.CONFIRMED, AppointmentStatus.CANCELLED],
  CONFIRMED: [
    AppointmentStatus.CHECKED_IN,
    AppointmentStatus.IN_PROGRESS,
    AppointmentStatus.COMPLETED,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ],
  CHECKED_IN: [
    AppointmentStatus.IN_PROGRESS,
    AppointmentStatus.COMPLETED,
    AppointmentStatus.CANCELLED,
  ],
  IN_PROGRESS: [AppointmentStatus.COMPLETED, AppointmentStatus.NO_SHOW],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

type CancelOptions = {
  reason?: string;
  fromStatuses?: AppointmentStatus[];
} & (
  | { by: "SALON" }
  // Whether the customer is inside the free window decides between a full
  // release and a late-cancellation penalty, so they must say which.
  | { by: "CUSTOMER"; freeCancellation: boolean }
);

/**
 * Cancels a booking, reopens its slot and settles its deposit in one
 * transaction. The status write is conditional on the booking still being in
 * one of `fromStatuses`, so of two cancels racing each other exactly one wins
 * and the other gets a 409 - the deposit can never be settled twice.
 */
const cancelInTx = async (appointmentId: string, options: CancelOptions) => {
  const fromStatuses = options.fromStatuses ?? [
    AppointmentStatus.PENDING,
    AppointmentStatus.CONFIRMED,
  ];

  const { cancelled, notify } = await prisma.$transaction(
    async (tx) => {
      const { count } = await tx.appointment.updateMany({
        where: { id: appointmentId, status: { in: fromStatuses } },
        data: {
          status: AppointmentStatus.CANCELLED,
          cancellationReason: options.reason,
        },
      });

      if (count === 0) {
        throw new ApiError(
          StatusCodes.CONFLICT,
          "This booking was already updated. Refresh and try again.",
        );
      }

      const cancelled = await tx.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
      });

      if (cancelled.slotId) {
        await tx.slot.updateMany({
          where: { id: cancelled.slotId },
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          data: { status: "AVAILABLE", isBooked: false },
        });
      }

      // The salon cancelling makes the customer whole plus a goodwill credit.
      // A customer cancelling in time gets the deposit back; too late and the
      // salon keeps a slice of it.
      if (options.by === "SALON") {
        const released = await AppointmentDeposit.settleReleasedTx(
          tx,
          appointmentId,
          { goodwill: true },
        );
        return {
          cancelled,
          notify: () => AppointmentDeposit.notifyReleased(released),
        };
      }

      if (options.freeCancellation) {
        const released = await AppointmentDeposit.settleReleasedTx(
          tx,
          appointmentId,
        );
        return {
          cancelled,
          notify: () => AppointmentDeposit.notifyReleased(released),
        };
      }

      const settled = await AppointmentDeposit.settleLateCancelledTx(
        tx,
        appointmentId,
      );
      return {
        cancelled,
        notify: () => AppointmentDeposit.notifyLateCancelled(settled),
      };
    },
    { timeout: 15000, maxWait: 10000 },
  );

  // Emails only once the money movement has committed.
  notify();

  return cancelled;
};

/** The statuses that still hold a customer's time. */
const ACTIVE_BOOKING_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.PENDING,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.CHECKED_IN,
];

/** How many live bookings one customer may hold at one salon on one day. */
const MAX_ACTIVE_BOOKINGS_PER_DAY = (() => {
  const parsed = Math.floor(
    Number(process.env.MAX_ACTIVE_BOOKINGS_PER_DAY ?? 3),
  );
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
})();

/**
 * Whether two same-day bookings share any time. "HH:mm" is zero-padded, so
 * string order is time order. A legacy booking with no end time counts as the
 * moment it starts.
 */
const timesOverlap = (
  a: { startTime: string; endTime: string | null },
  b: { startTime: string; endTime: string | null },
) =>
  a.startTime === b.startTime ||
  (a.startTime < (b.endTime ?? b.startTime) &&
    b.startTime < (a.endTime ?? a.startTime));

/**
 * Stops one customer holding two chairs at once, or taking most of a salon's
 * day. Locks the customer's user row first, so two bookings sent together
 * from two tabs are checked one after the other instead of both passing
 * against the same list. Must run inside the booking transaction.
 */
const assertWithinBookingLimits = async (
  tx: Prisma.TransactionClient,
  customerId: string,
  salonId: string,
  slot: Pick<Slot, "date" | "startTime" | "endTime">,
) => {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${customerId} FOR UPDATE`;

  const sameDay = await tx.appointment.findMany({
    where: {
      customerId,
      // A range rather than equality, for older rows stored off midnight.
      appointmentDate: {
        gte: slot.date,
        lt: new Date(slot.date.getTime() + 24 * 60 * 60 * 1000),
      },
      status: { in: ACTIVE_BOOKING_STATUSES },
    },
    select: { salonId: true, startTime: true, endTime: true },
  });

  if (sameDay.some((booking) => timesOverlap(booking, slot))) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "You already have a booking at this time",
    );
  }

  const atThisSalon = sameDay.filter(
    (booking) => booking.salonId === salonId,
  ).length;

  if (atThisSalon >= MAX_ACTIVE_BOOKINGS_PER_DAY) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      `You already have ${atThisSalon} bookings at this salon that day, the most allowed. Cancel one to book another time.`,
    );
  }
};

/** What a new booking comes back with, whoever made it. */
const newBookingInclude = {
  salon: {
    select: {
      id: true,
      name: true,
      address: true,
      phone: true,
    },
  },
  service: {
    select: {
      id: true,
      name: true,
      priceMinor: true,
      duration: true,
    },
  },
  staff: {
    include: {
      user: {
        select: {
          id: true,
          name: true,
          profilePhoto: true,
        },
      },
    },
  },
  counter: true,
  customer: {
    select: {
      id: true,
      name: true,
      phone: true,
    },
  },
} satisfies Prisma.AppointmentInclude;

type ClaimSlotInput = {
  slot: Slot;
  customerId: string;
  salonId: string;
  serviceId: string;
  counterId: string;
  staffId?: string | null;
  notes?: string;
  totalMinor: number;
  depositMinor: number;
  source: AppointmentSource;
  /** Which surface took the booking. Defaults to the review page. */
  bookedVia?: BookingChannel;
};

/**
 * The part every booking shares, online or walk-in: win the slot, give the
 * booking its queue identity, and write it. Runs in the caller's transaction,
 * so whatever the caller does next (a deposit hold) rolls the slot back with
 * it if it fails.
 */
const claimSlotAndCreate = async (
  tx: Prisma.TransactionClient,
  input: ClaimSlotInput,
) => {
  const now = new Date();

  const updatedSlot = await tx.slot.updateMany({
    where: {
      id: input.slot.id,
      status: "AVAILABLE",
      isBooked: false,
      // A hold taken in the chat blocks the website too, otherwise "held" would
      // mean nothing the moment the customer opened a second tab. Expiry is
      // part of the predicate, so a lapsed hold needs no sweep to clear it.
      OR: [
        { heldUntil: null },
        { heldUntil: { lt: now } },
        { heldByUserId: input.customerId },
      ],
    },
    data: {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      status: "BOOKED",
      isBooked: true,
      // The slot is BOOKED, so the hold has done its job; leaving it set would
      // only confuse anyone reading the row later.
      heldUntil: null,
      heldByUserId: null,
    },
  });

  if (updatedSlot.count === 0) {
    // Lost to a booking, or to somebody mid-checkout? The second is temporary
    // and the customer should hear that, rather than be told a time is gone
    // when it may come straight back.
    const heldByAnother = await tx.slot.findFirst({
      where: {
        id: input.slot.id,
        status: "AVAILABLE",
        isBooked: false,
        heldUntil: { gt: now },
      },
      select: { id: true },
    });

    throw new ApiError(
      StatusCodes.CONFLICT,
      heldByAnother
        ? "Someone is booking this time right now. Please try another time."
        : "Sorry, this slot has just been booked by another customer. Please select another available slot.",
    );
  }

  // Queue identity. The serial is the slot's position in its day, so it
  // is fixed by the slot the claim above just won - no lock needed.
  // Sequential, not Promise.all: these share one transaction connection.
  const token = await AppointmentIdentity.generateToken(tx);
  const serialNumber = await AppointmentIdentity.slotPosition(tx, input.slot);

  return tx.appointment.create({
    data: {
      customerId: input.customerId,
      salonId: input.salonId,
      serviceId: input.serviceId,
      staffId: input.staffId || null,
      counterId: input.counterId,
      appointmentDate: input.slot.date,
      startTime: input.slot.startTime,
      endTime: input.slot.endTime,
      notes: input.notes,
      slotId: input.slot.id,
      token,
      serialNumber,
      source: input.source,
      // Nothing is left for the salon to confirm: an online booking's deposit
      // is taken in this same transaction, and a walk-in was entered by the
      // salon itself.
      status: AppointmentStatus.CONFIRMED,
      bookedVia: input.bookedVia ?? BookingChannel.WEB,
      totalMinor: input.totalMinor,
      depositMinor: input.depositMinor,
      depositStatus:
        input.depositMinor > 0 ? DepositStatus.HELD : DepositStatus.NONE,
    },
    include: newBookingInclude,
  });
};

/**
 * Every check a booking must pass, and what it will cost. No writes.
 *
 * Split out of `bookAppointment` so the in-chat assistant can quote a price
 * and then re-quote it at Confirm time, running the same checks in the same
 * order with the same messages. There is one booking implementation; this is
 * its first half, and `bookAppointment` below is still the only caller that
 * writes anything.
 */
const quoteBooking = async (
  userId: string,
  payload: {
    salonId: string;
    serviceId: string;
    counterId: string;
    slotId: string;
    staffId?: string | null;
  },
) => {
  // Verify user is customer
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (
    !user ||
    (user.role !== UserRole.CUSTOMER &&
      user.role !== UserRole.SALON_OWNER &&
      user.role !== UserRole.ADMIN)
  ) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only customers can book appointments",
    );
  }

  // Verify slot first
  const slot = await prisma.slot.findUnique({
    where: { id: payload.slotId },
  });

  if (!slot || slot.status !== "AVAILABLE" || slot.isBooked) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "This slot is no longer available. Please select another time.",
    );
  }

  // The slot decides what is being sold. The price comes from the service in
  // the body, so a body that disagrees with the slot could book an expensive
  // slot at a cheap service's price.
  if (
    slot.salonId !== payload.salonId ||
    (slot.serviceId && slot.serviceId !== payload.serviceId) ||
    (slot.counterId && slot.counterId !== payload.counterId)
  ) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "This slot does not belong to the selected salon/service/counter.",
    );
  }

  // The list is filtered, but a stale tab or a hand-edited request can still
  // arrive for a time that has already come and gone. Selling it would create a
  // booking that the auto-start job immediately marks IN_PROGRESS and the
  // no-show sweep then forfeits - a deposit lost to a slot nobody could attend.
  if (hasSlotStarted(slot)) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "That time has already passed. Please select a later slot.",
    );
  }

  // Verify salon, service, and staff exist
  const [salon, service, staff, counter] = await Promise.all([
    prisma.salon.findUnique({
      where: {
        id: payload.salonId,
        isDeleted: false,
        status: SalonStatus.ACTIVE,
      },
      // Who to tell about the booking once it is made.
      include: {
        owner: { select: { user: { select: { email: true, name: true } } } },
      },
    }),
    prisma.service.findUnique({
      where: { id: payload.serviceId, isDeleted: false, isActive: true },
    }),
    payload.staffId
      ? prisma.staff.findUnique({
          where: { id: payload.staffId, isDeleted: false },
        })
      : Promise.resolve(null),
    prisma.counter.findUnique({
      where: { id: payload.counterId, isDeleted: false },
    }),
  ]);

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found or inactive");
  }

  if (!service) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Service not found or inactive");
  }

  if (payload.staffId && !staff) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Staff not found");
  }
  if (!counter) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Counter not found");
  }

  if (service.salonId !== salon.id || counter.salonId !== salon.id) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "This slot does not belong to the selected salon/service/counter.",
    );
  }

  if (staff && staff.salonId !== payload.salonId) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Selected staff does not belong to this salon",
    );
  }

  // What this booking costs, and what it costs to not turn up. Both are frozen
  // onto the appointment now, so a later price or policy change cannot rewrite
  // a deal the customer already agreed to.
  const totalMinor = service.priceMinor;
  const depositMinor = AppointmentDeposit.resolveDepositMinor(
    salon,
    totalMinor,
  );

  return { user, slot, salon, service, staff, counter, totalMinor, depositMinor };
};

export type BookingQuote = Awaited<ReturnType<typeof quoteBooking>>;

const bookAppointment = async (
  userId: string,
  payload: any,
): Promise<Awaited<ReturnType<typeof claimSlotAndCreate>>> => {
  const { user, slot, salon, totalMinor, depositMinor } = await quoteBooking(
    userId,
    payload,
  );

  // Transaction for double booking prevention. The deposit hold lives in here
  // too: if the customer cannot cover it the whole thing rolls back and the
  // slot is released, rather than leaving a booking nobody has paid to keep.
  const appointment = await prisma
    .$transaction(
      async (tx) => {
        await assertWithinBookingLimits(tx, userId, payload.salonId, slot);

        const createdAppointment = await claimSlotAndCreate(tx, {
          slot,
          customerId: userId,
          salonId: payload.salonId,
          serviceId: payload.serviceId,
          counterId: payload.counterId,
          staffId: payload.staffId,
          notes: payload.notes,
          totalMinor,
          depositMinor,
          source: AppointmentSource.PLATFORM,
          // The chat passes ASSISTANT; the review page passes nothing and gets
          // WEB. Same transaction, same emails, same token either way.
          bookedVia: payload.bookedVia,
        });

        if (depositMinor > 0) {
          await WalletService.holdDeposit(
            userId,
            depositMinor,
            createdAppointment.id,
            tx,
          );
        }

        return createdAppointment;
      },
      { timeout: 15000, maxWait: 10000 },
    )
    .catch(async (error) => {
      // An empty wallet is not a server error - it is a prompt to top up.
      if (
        error instanceof ApiError &&
        error.statusCode === StatusCodes.BAD_REQUEST &&
        error.message.startsWith("Insufficient")
      ) {
        const wallet = await WalletService.getWalletSummary(userId);
        const shortfall = Math.max(depositMinor - wallet.availableMinor, 0);

        throw new ApiError(
          StatusCodes.PAYMENT_REQUIRED,
          `Add ${formatBDT(shortfall)} to your wallet to confirm this booking. A ${formatBDT(depositMinor)} deposit is held and returned when you turn up.`,
        );
      }

      throw error;
    });

  // Stored as UTC midnight of the calendar day, so it must be read in UTC -
  // any other zone west of it would print the day before.
  const formattedDate = new Date(
    appointment.appointmentDate,
  ).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  // Send email notification asynchronously
  if (user?.email) {
    const emailHtml = getBookingConfirmationTemplate(
      user.name || "Customer",
      appointment.salon.name,
      appointment.service.name,
      formattedDate,
      appointment.startTime,
      depositMinor > 0
        ? `${formatBDT(totalMinor)} (${formatBDT(depositMinor)} deposit held, ${formatBDT(totalMinor - depositMinor)} due at the salon)`
        : formatBDT(totalMinor),
      {
        token: appointment.token,
        serialNumber: appointment.serialNumber,
        staffName: appointment.staff?.user?.name,
        counterName: appointment.counter?.name,
      },
    );

    // Call without await so it doesn't block the API response
    sendEmail(user.email, "Booking Confirmation - Salon Management", emailHtml);
  }

  // Tell the owner, so a booking made overnight is not first seen when the
  // customer walks in. Also not awaited.
  const owner = salon.owner.user;
  if (owner.email) {
    const serial = appointment.serialNumber
      ? ` #${appointment.serialNumber}`
      : "";

    sendEmail(
      owner.email,
      `New booking${serial} - ${appointment.service.name}`,
      getNewBookingOwnerTemplate({
        ownerName: owner.name || "there",
        salonName: appointment.salon.name,
        customerName: user.name || "A customer",
        serviceName: appointment.service.name,
        counterName: appointment.counter?.name,
        serialNumber: appointment.serialNumber,
        token: appointment.token,
        date: formattedDate,
        time: appointment.endTime
          ? `${appointment.startTime} - ${appointment.endTime}`
          : appointment.startTime,
        dueAtCounter: formatBDT(totalMinor - depositMinor),
      }),
    );
  }

  return appointment;
};

// Walk-in customers get an address on `.invalid`, a top-level domain reserved
// so that it never resolves (RFC 2606): no mail sent to one can reach anybody.
const WALK_IN_EMAIL_DOMAIN = "walk-in.invalid";

/** "+880 1712-345678" and "01712345678" are the same Bangladeshi number. */
const normalizePhone = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("8801")
    ? digits.slice(2)
    : digits;
};

/**
 * The placeholder account's address, the same for the same name and phone, so
 * a regular's visits line up under one customer. The name is part of the key
 * because families share a phone.
 *
 * It is an HMAC rather than the phone itself because phone numbers are easy
 * to guess: anyone who registered `walkin-<phone>@...` first would otherwise
 * be handed every walk-in booked under that number. Rotating the secret only
 * means returning walk-ins get a new placeholder.
 */
const walkInEmail = (name: string, phone: string) => {
  const key = `${phone}|${name.replace(/\s+/g, " ").toLowerCase()}`;
  const digest = createHmac("sha256", config.jwt.jwt_secret)
    .update(key)
    .digest("hex")
    .slice(0, 32);

  return `walkin-${digest}@${WALK_IN_EMAIL_DOMAIN}`;
};

/**
 * A walk-in or phone booking the salon enters for somebody. Every appointment
 * needs a customer, and a user needs an email and a password, so the person
 * gets a placeholder account nobody can sign in to (see `walkInEmail`). It is
 * never matched to a registered customer by phone: the salon typed that
 * number and nobody has verified it.
 *
 * No deposit, no booking limits and no emails - the salon is the one asking,
 * and there is nobody to write to.
 */
const bookWalkIn = async (
  actor: { userId: string; role: string },
  payload: {
    slotId: string;
    customerName: string;
    customerPhone: string;
    notes?: string;
  },
) => {
  const slot = await prisma.slot.findUnique({
    where: { id: payload.slotId },
  });

  if (!slot) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Slot not found");
  }

  await assertCanActOnAppointment(
    actor.userId,
    actor.role,
    slot.salonId,
    "You can only add bookings for your own salon",
  );

  if (slot.status !== "AVAILABLE" || slot.isBooked) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "This slot is no longer available. Please select another time.",
    );
  }

  // Same rule as online: a started slot is one the no-show sweep would soon
  // mark missed before anyone pressed Check in.
  if (hasSlotStarted(slot)) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      "That time has already passed. Please select a later slot.",
    );
  }

  if (!slot.serviceId || !slot.counterId) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "This slot has no service or counter, so it cannot be booked.",
    );
  }

  const [salon, service, counter] = await Promise.all([
    prisma.salon.findUnique({
      where: { id: slot.salonId, isDeleted: false, status: SalonStatus.ACTIVE },
    }),
    prisma.service.findUnique({
      where: { id: slot.serviceId, isDeleted: false, isActive: true },
    }),
    prisma.counter.findUnique({
      where: { id: slot.counterId, isDeleted: false },
    }),
  ]);

  if (!salon) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found or inactive");
  }

  if (!service) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Service not found or inactive");
  }

  if (!counter) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Counter not found");
  }

  if (service.salonId !== salon.id || counter.salonId !== salon.id) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "This slot does not belong to the selected salon/service/counter.",
    );
  }

  const customerName = payload.customerName.trim();
  const customerPhone = normalizePhone(payload.customerPhone);
  const email = walkInEmail(customerName, customerPhone);

  // Hashed out here because bcrypt is slow on purpose and the slot claim
  // should not wait on it. Only stored if the placeholder is new, and never
  // shown to anyone.
  const password = await bcrypt.hash(randomBytes(32).toString("hex"), 12);

  return prisma.$transaction(
    async (tx) => {
      const customer = await tx.user.upsert({
        where: { email },
        update: {},
        create: {
          email,
          password,
          name: customerName,
          phone: customerPhone,
          role: UserRole.CUSTOMER,
        },
      });

      return claimSlotAndCreate(tx, {
        slot,
        customerId: customer.id,
        salonId: salon.id,
        serviceId: service.id,
        counterId: counter.id,
        notes: payload.notes,
        totalMinor: service.priceMinor,
        depositMinor: 0,
        source: AppointmentSource.SALON_DIRECT,
      });
    },
    { timeout: 15000, maxWait: 10000 },
  );
};

const getAllAppointments = async (
  userId: string,
  userRole: string,
  query: any,
) => {
  const { status, salonId, serviceId, counterId, date } = query;
  const searchTerm =
    typeof query.searchTerm === "string" ? query.searchTerm.trim() : "";
  const pageNum = Math.max(Math.floor(Number(query.page)) || 1, 1);
  const limitNum = Math.min(
    Math.max(Math.floor(Number(query.limit)) || 20, 1),
    100,
  );
  const skip = (pageNum - 1) * limitNum;

  // Checked before any query so a bad value is a 400, not a Prisma 500.
  let dayStart: Date | undefined;
  if (date) {
    dayStart = new Date(`${date}T00:00:00.000Z`);
    // The round trip rejects dates that parse but do not exist, like 2026-02-30.
    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(dayStart.getTime()) ||
      dayStart.toISOString().slice(0, 10) !== date
    ) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        "date must be a calendar day in YYYY-MM-DD format.",
      );
    }
  }
  if (
    status &&
    !Object.values(AppointmentStatus).includes(status as AppointmentStatus)
  ) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `Unknown status "${status}".`);
  }

  const emptyResult = {
    meta: {
      page: pageNum,
      limit: limitNum,
      total: 0,
      totalPage: 0,
      statusCounts: {},
    },
    data: [],
  };

  const whereConditions: any = {};

  // -------------------------
  // Role-based filtering
  // -------------------------
  if (userRole === UserRole.CUSTOMER) {
    // Customer sees only own appointments
    whereConditions.customerId = userId;
  } else if (userRole === UserRole.STAFF) {
    // Staff userId -> find staff profile -> filter by staffId
    const staff = await prisma.staff.findUnique({
      where: { userId },
      select: { id: true },
    });

    // If staff profile doesn't exist, return no data
    if (!staff) {
      return emptyResult;
    }

    whereConditions.staffId = staff.id;
  } else if (userRole === UserRole.SALON_OWNER) {
    // ✅ userId is from User table, so match by salonOwner.userId
    const salonOwner = await prisma.salonOwner.findUnique({
      where: { userId },
      include: {
        salons: {
          select: { id: true },
        },
      },
    });

    // If no owner profile or no salons, return empty
    if (!salonOwner || salonOwner.salons.length === 0) {
      return emptyResult;
    }

    whereConditions.salonId = {
      in: salonOwner.salons.map((s: any) => s.id),
    };
  }

  // Admin can see all (no extra role filter)
  // else if (userRole === UserRole.ADMIN) { }
  else if (userRole === "AGENT") {
    const agent = await prisma.agent.findUnique({
      where: { userId },
      select: { area: true },
    });

    if (!agent) {
      return emptyResult;
    }

    // Find all salons in this agent's area
    const salonsInArea = await prisma.salon.findMany({
      where: { area: agent.area, isDeleted: false },
      select: { id: true },
    });

    whereConditions.salonId = {
      in: salonsInArea.map((s: any) => s.id),
    };
  }

  // -------------------------
  // Additional query filters
  // -------------------------
  if (typeof serviceId === "string" && serviceId) {
    whereConditions.serviceId = serviceId;
  }
  if (typeof counterId === "string" && counterId) {
    whereConditions.counterId = counterId;
  }

  // Appointment dates are stored as UTC midnight, so one calendar day is
  // exactly [that midnight, the next one).
  if (dayStart) {
    whereConditions.appointmentDate = {
      gte: dayStart,
      lt: new Date(dayStart.getTime() + 24 * 60 * 60 * 1000),
    };
  }

  // Tokens are issued upper-case, so a typed "ab12" still finds "AB12".
  if (searchTerm) {
    whereConditions.OR = [
      { customer: { name: { contains: searchTerm, mode: "insensitive" } } },
      { customer: { phone: { contains: searchTerm, mode: "insensitive" } } },
      { token: searchTerm.toUpperCase() },
    ];
  }

  // Optional salonId filter
  // For salon owner: this still works, but only if salonId belongs to owner's salons due to previous `in` filter.
  // To avoid override bug, combine carefully:
  if (salonId) {
    // if salonId already has "in" filter from owner, combine with exact match
    if (
      whereConditions.salonId &&
      typeof whereConditions.salonId === "object"
    ) {
      const allowedSalonIds = whereConditions.salonId.in || [];
      if (!allowedSalonIds.includes(salonId)) {
        return emptyResult;
      }
      whereConditions.salonId = salonId;
    } else {
      whereConditions.salonId = salonId;
    }
  }

  // Status goes on last: the chip counts need every other filter but this one.
  const statusCountWhere = { ...whereConditions };
  if (status) {
    whereConditions.status = status;
  }

  // One day reads as a queue; a date range reads newest first. `id` breaks
  // ties so rows never repeat or vanish between pages.
  const orderBy: Prisma.AppointmentOrderByWithRelationInput[] = dayStart
    ? [{ startTime: "asc" }, { serialNumber: "asc" }, { id: "asc" }]
    : [{ appointmentDate: "desc" }, { startTime: "desc" }, { id: "asc" }];

  const [appointments, total, statusGroups] = await Promise.all([
    prisma.appointment.findMany({
      where: whereConditions,
      skip,
      take: limitNum,
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            profilePhoto: true,
          },
        },
        salon: {
          select: {
            id: true,
            name: true,
            address: true,
            phone: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
            priceMinor: true,
            duration: true,
            category: true,
          },
        },
        staff: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                profilePhoto: true,
              },
            },
          },
        },
        counter: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        payment: true,
      },
      orderBy,
    }),
    prisma.appointment.count({ where: whereConditions }),
    prisma.appointment.groupBy({
      by: ["status"],
      where: statusCountWhere,
      _count: true,
    }),
  ]);

  const statusCounts: Partial<Record<AppointmentStatus, number>> = {};
  for (const group of statusGroups) {
    statusCounts[group.status] = group._count;
  }

  return {
    meta: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPage: Math.ceil(total / limitNum),
      statusCounts,
    },
    data: appointments.map(withPaymentSummary),
  };
};

const getMyAppointments = async (userId: string, query: any) => {
  const { page = 1, limit = 10, status, salonId, scope } = query;
  const skip = (Number(page) - 1) * Number(limit);

  const whereConditions: any = {
    customerId: userId,
  };

  if (status) {
    whereConditions.status = status;
  }

  if (salonId) {
    whereConditions.salonId = salonId;
  }

  // "upcoming" is a live booking from today on, soonest first; "past" is
  // everything else, newest first. Without a scope the list stays in booking
  // order, as the dashboard has always had it. Today is the server's calendar
  // day as UTC midnight, the way `appointmentDate` is written.
  let orderBy: Prisma.AppointmentOrderByWithRelationInput[] = [
    { createdAt: "desc" },
  ];

  if (scope === "upcoming" || scope === "past") {
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
    );
    const live = {
      status: { in: [...ACTIVE_BOOKING_STATUSES, AppointmentStatus.IN_PROGRESS] },
      appointmentDate: { gte: today },
    };

    if (scope === "upcoming") {
      whereConditions.AND = [live];
      orderBy = [{ appointmentDate: "asc" }, { startTime: "asc" }];
    } else {
      whereConditions.NOT = live;
      orderBy = [{ appointmentDate: "desc" }, { startTime: "desc" }];
    }
  }

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where: whereConditions,
      skip,
      take: Number(limit),
      include: {
        salon: {
          select: {
            id: true,
            name: true,
            address: true,
            phone: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
            priceMinor: true,
            duration: true,
            category: true,
          },
        },
        staff: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                profilePhoto: true,
              },
            },
          },
        },
        counter: { select: { id: true, name: true, code: true } },
        payment: true,
        review: true,
      },
      orderBy,
    }),
    prisma.appointment.count({ where: whereConditions }),
  ]);

  return {
    meta: {
      page: Number(page),
      limit: Number(limit),
      total,
    },
    data: appointments.map(withPaymentSummary),
  };
};

/**
 * Whether this user may see this booking at all. The row carries the
 * customer's phone and email, so it is the customer, their salon, or an admin.
 */
const canViewAppointment = async (
  appointment: {
    customerId: string;
    salonId: string;
    salon: { ownerId: string };
  },
  userId: string,
  userRole: string,
) => {
  switch (userRole) {
    case UserRole.ADMIN:
      return true;
    case UserRole.CUSTOMER:
      return appointment.customerId === userId;
    case UserRole.SALON_OWNER: {
      const owner = await prisma.salonOwner.findUnique({ where: { userId } });
      return owner !== null && appointment.salon.ownerId === owner.id;
    }
    case UserRole.STAFF: {
      const staff = await prisma.staff.findFirst({
        where: { userId, salonId: appointment.salonId, isDeleted: false },
        select: { id: true },
      });
      return Boolean(staff);
    }
    default:
      return false;
  }
};

const getAppointmentById = async (
  id: string,
  userId: string,
  userRole: string,
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id },
    include: appointmentDetailInclude,
  });

  // Someone else's booking reads as missing rather than forbidden, so ids
  // cannot be probed for existence.
  if (
    !appointment ||
    !(await canViewAppointment(appointment, userId, userRole))
  ) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  return withPaymentSummary(appointment);
};

const updateAppointmentStatus = async (
  userId: string,
  userRole: string,
  appointmentId: string,
  payload: any,
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      salon: true,
      staff: true,
    },
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  // Verify permissions
  if (userRole === UserRole.CUSTOMER) {
    if (appointment.customerId !== userId) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You can only update your own appointments",
      );
    }
    // Customers can only cancel
    if (payload.status !== "CANCELLED") {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "Customers can only cancel appointments",
      );
    }
  } else if (userRole === UserRole.STAFF) {
    if (appointment?.staff?.userId !== userId) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You can only update appointments assigned to you",
      );
    }
  } else if (userRole === UserRole.SALON_OWNER) {
    const salonOwner = await prisma.salonOwner.findUnique({
      where: { userId },
    });
    if (!salonOwner || appointment.salon.ownerId !== salonOwner.id) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You can only update appointments for your salons",
      );
    }
  }

  if (
    payload.staffId &&
    userRole !== UserRole.SALON_OWNER &&
    userRole !== UserRole.ADMIN
  ) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can assign staff to appointments",
    );
  }

  if (payload.staffId) {
    const staff = await prisma.staff.findFirst({
      where: {
        id: payload.staffId,
        salonId: appointment.salonId,
        isDeleted: false,
      },
      select: { id: true },
    });

    if (!staff) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        "Selected staff does not belong to this salon",
      );
    }
  }

  const from = appointment.status;
  const to: AppointmentStatus = payload.status ?? from;

  // Assigning staff re-sends the current status. That is the one same-status
  // update allowed, and it changes nothing but the staff.
  if (to === from && payload.staffId) {
    return prisma.appointment.update({
      where: { id: appointmentId },
      data: { staffId: payload.staffId },
    });
  }

  if (!TRANSITIONS[from].includes(to)) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Cannot change a ${from} booking to ${to}`,
    );
  }

  // A no-show forfeits real money, so it is the one transition with its own
  // guard: only the salon or an admin, and only once the slot has passed.
  if (to === AppointmentStatus.NO_SHOW) {
    AppointmentDeposit.assertCanMarkNoShow(userRole, appointment);

    // Only a legacy row the old auto-start job moved to IN_PROGRESS can still
    // be a no-show from there. A checked-in customer turned up.
    if (appointment.checkedInAt) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        "This customer was checked in, so they cannot be marked as a no-show",
      );
    }
  }

  // Check-in and completion go through the counter flow, so the old
  // "Complete" button still records a payment rather than leaving the bill
  // open.
  if (
    to === AppointmentStatus.CHECKED_IN ||
    to === AppointmentStatus.COMPLETED
  ) {
    const user = { userId, role: userRole };

    const result =
      to === AppointmentStatus.CHECKED_IN
        ? await AppointmentCheckout.checkIn(user, appointmentId)
        : await AppointmentCheckout.checkout(user, appointmentId, {
            paymentMethod: "CASH",
          });

    // Only once the status change has landed, so a refused check-in or
    // checkout leaves the booking exactly as it was.
    if (payload.staffId) {
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { staffId: payload.staffId },
      });
    }

    return result;
  }

  if (to === AppointmentStatus.CANCELLED) {
    if (userRole === UserRole.CUSTOMER) {
      if (from === AppointmentStatus.CHECKED_IN) {
        throw new ApiError(
          StatusCodes.BAD_REQUEST,
          "You've already checked in. Please ask the salon to cancel.",
        );
      }

      // A customer cancelling through this endpoint gets the same time check
      // as the dedicated cancel route - otherwise it is a way around it.
      // Cancelling too late costs the salon a slot it cannot refill, so it
      // costs the customer a slice of the deposit - but only a slice.
      AppointmentDeposit.assertCancellable(appointment);
      return cancelInTx(appointmentId, {
        by: "CUSTOMER",
        freeCancellation: AppointmentDeposit.isWithinFreeCancellation(
          appointment,
          appointment.salon,
        ),
        reason: payload.cancellationReason,
        fromStatuses: [from],
      });
    }

    // The salon or an admin cancelled: the customer is made whole and gets a
    // salon-funded credit for the trouble.
    return cancelInTx(appointmentId, {
      by: "SALON",
      reason: payload.cancellationReason,
      fromStatuses: [from],
    });
  }

  // The write only lands if the booking is still in the status the guards
  // above were checked against, and the deposit is settled in the same
  // transaction - so a lost race never settles, and a settled booking always
  // has its new status.
  // Starting a booking nobody checked in means the customer is in the chair,
  // so it counts as the check-in. Without the stamp the no-show job would read
  // the row as a legacy auto-start and could forfeit their deposit.
  const implicitCheckIn =
    from === AppointmentStatus.CONFIRMED &&
    to === AppointmentStatus.IN_PROGRESS;

  const { result, forfeited } = await prisma.$transaction(
    async (tx) => {
      const { count } = await tx.appointment.updateMany({
        where: { id: appointmentId, status: from },
        data: {
          status: to,
          ...(payload.staffId && { staffId: payload.staffId }),
          ...(implicitCheckIn && {
            checkedInAt: new Date(),
            checkedInById: userId,
          }),
        },
      });

      if (count === 0) {
        throw new ApiError(
          StatusCodes.CONFLICT,
          "This booking was already updated. Refresh and try again.",
        );
      }

      const forfeited =
        to === AppointmentStatus.NO_SHOW
          ? await AppointmentDeposit.settleForfeitedTx(tx, appointmentId)
          : null;

      const result = await tx.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
      });

      return { result, forfeited };
    },
    { timeout: 15000, maxWait: 10000 },
  );

  AppointmentDeposit.notifyForfeited(forfeited);

  return result;
};

const cancelAppointment = async (
  userId: string,
  userRole: string,
  appointmentId: string,
  reason?: string,
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { salon: true },
  });

  if (!appointment) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  const bySalon = userRole === UserRole.SALON_OWNER;

  if (bySalon) {
    const owner = await prisma.salonOwner.findUnique({ where: { userId } });
    if (!owner || appointment.salon.ownerId !== owner.id) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You can only cancel bookings for your own salon",
      );
    }
  } else if (appointment.customerId !== userId) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You can only cancel your own appointments",
    );
  }

  if (
    ["COMPLETED", "CANCELLED", "IN_PROGRESS", "NO_SHOW"].includes(
      appointment.status,
    )
  ) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Cannot cancel ${appointment.status.toLowerCase().replace("_", " ")} appointment`,
    );
  }

  if (!bySalon && appointment.status === AppointmentStatus.CHECKED_IN) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "You've already checked in. Please ask the salon to cancel.",
    );
  }

  // The salon cancelling is never the customer's fault: the whole deposit
  // comes back plus a goodwill credit, whatever the time.
  if (bySalon) {
    const result = await cancelInTx(appointmentId, {
      by: "SALON",
      reason,
      fromStatuses: [
        AppointmentStatus.PENDING,
        AppointmentStatus.CONFIRMED,
        AppointmentStatus.CHECKED_IN,
      ],
    });
    const depositMinor = Math.max(appointment.depositMinor, 0);

    return {
      ...result,
      depositRefunded: depositMinor > 0,
      fullRefund: true,
      depositMinor,
      refundMinor: depositMinor,
      penaltyMinor: 0,
      penaltyPercent: 0,
      cancellationWindowMin: appointment.salon.cancellationWindowMin,
    };
  }

  // Past the start time there is nothing to cancel - only a completion or a
  // no-show. This has to come before any write.
  AppointmentDeposit.assertCancellable(appointment);

  const quote = AppointmentDeposit.cancellationQuote(
    appointment,
    appointment.salon,
  );

  // Outside the window the deposit comes back whole. Inside it the slot is too
  // close to resell, so the salon keeps the penalty and the customer gets the
  // rest back - a late cancellation is not as expensive as never showing up.
  const result = await cancelInTx(appointmentId, {
    by: "CUSTOMER",
    freeCancellation: quote.freeCancellation,
    reason,
  });

  return {
    ...result,
    depositRefunded: quote.refundMinor > 0,
    fullRefund: quote.freeCancellation,
    depositMinor: quote.depositMinor,
    refundMinor: quote.refundMinor,
    penaltyMinor: quote.penaltyMinor,
    penaltyPercent: quote.penaltyPercent,
    cancellationWindowMin: appointment.salon.cancellationWindowMin,
  };
};

/**
 * What cancelling right now would cost. The frontend shows this before the
 * confirm button, so a forfeit is never a surprise.
 */
const getCancellationPreview = async (
  userId: string,
  appointmentId: string,
) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { salon: true },
  });

  if (!appointment || appointment.customerId !== userId) {
    throw new ApiError(StatusCodes.NOT_FOUND, "Appointment not found");
  }

  const quote = AppointmentDeposit.cancellationQuote(
    appointment,
    appointment.salon,
  );

  return {
    appointmentId,
    startsAt: quote.startsAt,
    cancellationWindowMin: quote.cancellationWindowMin,
    depositMinor: quote.depositMinor,
    freeCancellation: quote.freeCancellation,
    refundMinor: quote.refundMinor,
    // Kept under the old name so existing clients still read the deduction.
    forfeitMinor: quote.penaltyMinor,
    penaltyMinor: quote.penaltyMinor,
    penaltyPercent: quote.penaltyPercent,
    // False once the appointment has started: cancelling is no longer allowed.
    cancellable: !quote.started,
  };
};

const appealNoShow = async (
  userId: string,
  appointmentId: string,
  reason: string,
) => AppointmentDeposit.appealNoShow(userId, appointmentId, reason);

const resolveAppeal = async (
  adminUserId: string,
  appointmentId: string,
  payload: { approve: boolean; note?: string },
) => AppointmentDeposit.resolveAppeal(adminUserId, appointmentId, payload);

export const AppointmentService = {
  bookAppointment,
  // Exported for the assistant, which quotes a price in the chat and re-quotes
  // it at Confirm. Read-only: it never books.
  quoteBooking,
  bookWalkIn,
  getAllAppointments,
  getMyAppointments,
  getAppointmentById,
  updateAppointmentStatus,
  cancelAppointment,
  getCancellationPreview,
  appealNoShow,
  resolveAppeal,
};
