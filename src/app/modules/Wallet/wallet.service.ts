import { Prisma, WalletTransaction, WalletTxType } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";

/**
 * Every movement of customer money goes through `mutate`. Nothing else writes
 * to `wallets` or `wallet_transactions` - not the booking flow, not the IPN
 * handler, not the admin tools. That single entry point is what makes the
 * locking and the idempotency guarantees actually hold.
 */

type WalletRow = {
  id: string;
  userId: string;
  balance: number;
  heldBalance: number;
  currency: string;
  isFrozen: boolean;
};

export type MutateArgs = {
  userId: string;
  type: WalletTxType;
  /** SIGNED poisha. Credits positive, debits negative. */
  amount: number;
  /** SIGNED poisha change to heldBalance. */
  holdDelta?: number;
  description: string;
  referenceType?: string;
  referenceId?: string;
  /**
   * Derived from the thing being paid for, never random - `hold:<id>`,
   * `topup:<tran_id>`. A replayed webhook or a double-clicked button then
   * resolves to the row that already exists instead of moving money twice.
   */
  idempotencyKey?: string;
  metadata?: Prisma.InputJsonValue;
};

/** 40001 serialization failure, 40P01 deadlock - both mean "try again". */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

/**
 * Serializable transactions abort under contention, and the abort reaches us in
 * two different shapes. Prisma's own operations raise P2034, but a conflict
 * inside `$queryRaw` arrives as P2010 with the SQLSTATE buried in `meta.code` -
 * and `SELECT ... FOR UPDATE` is a raw query here, so that is the shape that
 * actually shows up when two customers hold against the same wallet.
 */
const isRetryableConflict = (error: unknown): boolean => {
  const candidate = error as {
    code?: string;
    meta?: { code?: string };
  } | null;

  if (!candidate) return false;
  if (candidate.code === "P2034") return true;

  const sqlState = candidate.meta?.code ?? candidate.code;
  return typeof sqlState === "string" && RETRYABLE_SQLSTATES.has(sqlState);
};

const MAX_ATTEMPTS = 6;

const runSerializable = async <T>(
  fn: (db: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
        // Concurrent holds queue on the same row lock, and opening a fresh
        // connection to a hosted Postgres is not instant. The 2s default here
        // rejects legitimate bookings as "unable to start a transaction".
        maxWait: 10000,
      });
    } catch (error) {
      // A serialization failure means somebody else got there first, not that
      // the caller did anything wrong. Retrying is the documented fix; without
      // it two legitimate concurrent holds would surface as a 500.
      if (!isRetryableConflict(error)) throw error;
      lastError = error;

      // Jittered backoff: without it, contenders that aborted together retry
      // together and collide again.
      const backoff = 20 * (attempt + 1) + Math.floor(Math.random() * 25);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw lastError;
};

/**
 * Wallets are created on first use so existing users need no backfill. The
 * unique constraint on userId settles the race if two requests arrive together.
 */
const getOrCreateWallet = async (
  userId: string,
  db: Prisma.TransactionClient = prisma,
) => {
  const existing = await db.wallet.findUnique({ where: { userId } });
  if (existing) return existing;

  try {
    return await db.wallet.create({ data: { userId } });
  } catch (error) {
    const wallet = await db.wallet.findUnique({ where: { userId } });
    if (!wallet) throw error;
    return wallet;
  }
};

/** Money that is held is still the customer's, but it is not theirs to spend. */
const availableOf = (wallet: { balance: number; heldBalance: number }) =>
  wallet.balance - wallet.heldBalance;

/**
 * A freeze stops a customer moving money, but it must not trap an admin
 * correction - otherwise a frozen wallet is a wallet nobody can ever fix.
 */
const ALLOWED_WHILE_FROZEN: WalletTxType[] = [WalletTxType.ADJUSTMENT];

const mutate = async (args: MutateArgs, tx?: Prisma.TransactionClient) => {
  const run = async (db: Prisma.TransactionClient) => {
    // 1. Idempotency. If this exact operation already landed, hand back the
    //    original row rather than applying it a second time.
    if (args.idempotencyKey) {
      const existing = await db.walletTransaction.findUnique({
        where: { idempotencyKey: args.idempotencyKey },
      });
      if (existing) return existing;
    }

    // Make sure there is a row to lock. This has to be ON CONFLICT DO NOTHING
    // rather than the find-then-create above: inside a transaction a unique
    // violation aborts the whole transaction, so two first-ever operations
    // racing each other would both fail instead of one simply waiting.
    await db.$executeRaw`
      INSERT INTO wallets (id, "userId", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, ${args.userId}, NOW(), NOW())
      ON CONFLICT ("userId") DO NOTHING
    `;

    // 2. Lock the row. Everything below is serialised per user, so two bookings
    //    cannot both read the same balance and both decide it is sufficient.
    const [wallet] = await db.$queryRaw<WalletRow[]>`
      SELECT * FROM wallets WHERE "userId" = ${args.userId} FOR UPDATE
    `;

    if (!wallet) {
      throw new ApiError(StatusCodes.NOT_FOUND, "Wallet not found");
    }

    if (wallet.isFrozen && !ALLOWED_WHILE_FROZEN.includes(args.type)) {
      throw new ApiError(StatusCodes.FORBIDDEN, "Wallet is frozen");
    }

    // 3. Compute and check.
    const newBalance = wallet.balance + args.amount;
    const newHeld = wallet.heldBalance + (args.holdDelta ?? 0);

    if (newBalance < 0) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        "Insufficient wallet balance",
      );
    }
    if (newHeld < 0) {
      throw new ApiError(StatusCodes.BAD_REQUEST, "Invalid hold release");
    }
    if (newHeld > newBalance) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        "Insufficient available balance",
      );
    }

    // 4. Write both sides together: the cached balance and the ledger row that
    //    justifies it. The database CHECK constraints backstop all of the above.
    await db.wallet.update({
      where: { id: wallet.id },
      data: { balance: newBalance, heldBalance: newHeld },
    });

    return db.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: args.type,
        amount: args.amount,
        balanceAfter: newBalance,
        heldAfter: newHeld,
        description: args.description,
        referenceType: args.referenceType,
        referenceId: args.referenceId,
        idempotencyKey: args.idempotencyKey,
        metadata: args.metadata,
      },
    });
  };

  // Join the caller's transaction when there is one: a booking has to hold the
  // deposit and create the appointment atomically, or neither.
  return tx ? run(tx) : runSerializable(run);
};

// ---------------------------------------------------------------------------
// Deposit wrappers. Each key is derived from the appointment, so every one of
// these is safe to call twice.
// ---------------------------------------------------------------------------

const holdDeposit = (
  userId: string,
  amountMinor: number,
  appointmentId: string,
  tx?: Prisma.TransactionClient,
) =>
  mutate(
    {
      userId,
      type: WalletTxType.DEPOSIT_HOLD,
      amount: 0,
      holdDelta: amountMinor,
      description: "Booking deposit held",
      referenceType: "APPOINTMENT",
      referenceId: appointmentId,
      idempotencyKey: `hold:${appointmentId}`,
      // A hold moves money into heldBalance without changing the total, so
      // the row carries amount 0. Record the delta or the ledger shows ৳0.
      metadata: { holdDeltaMinor: amountMinor },
    },
    tx,
  );

const releaseDeposit = (
  userId: string,
  amountMinor: number,
  appointmentId: string,
  tx?: Prisma.TransactionClient,
) =>
  mutate(
    {
      userId,
      type: WalletTxType.DEPOSIT_RELEASE,
      amount: 0,
      holdDelta: -amountMinor,
      description: "Deposit released - booking cancelled in time",
      referenceType: "APPOINTMENT",
      referenceId: appointmentId,
      idempotencyKey: `release:${appointmentId}`,
      metadata: { holdDeltaMinor: -amountMinor },
    },
    tx,
  );

const applyDeposit = (
  userId: string,
  amountMinor: number,
  appointmentId: string,
  tx?: Prisma.TransactionClient,
) =>
  mutate(
    {
      userId,
      type: WalletTxType.DEPOSIT_APPLIED,
      amount: -amountMinor,
      holdDelta: -amountMinor,
      description: "Deposit applied to your bill",
      referenceType: "APPOINTMENT",
      referenceId: appointmentId,
      idempotencyKey: `apply:${appointmentId}`,
    },
    tx,
  );

const forfeitDeposit = (
  userId: string,
  amountMinor: number,
  appointmentId: string,
  tx?: Prisma.TransactionClient,
) =>
  mutate(
    {
      userId,
      type: WalletTxType.DEPOSIT_FORFEIT,
      amount: -amountMinor,
      holdDelta: -amountMinor,
      description: "Deposit forfeited - marked as no-show",
      referenceType: "APPOINTMENT",
      referenceId: appointmentId,
      idempotencyKey: `forfeit:${appointmentId}`,
    },
    tx,
  );

// ---------------------------------------------------------------------------
// Read paths and admin tools
// ---------------------------------------------------------------------------

/**
 * The ledger columns hold poisha but are not named with the `Minor` suffix, so
 * on their own they would reach the client as raw poisha under taka-looking
 * names - BDT 30 rendered as 3000. Re-projecting them lets `sendResponse` add
 * the taka twins that every other money field in this API carries.
 */
const serializeTransaction = ({
  amount,
  balanceAfter,
  heldAfter,
  ...rest
}: WalletTransaction) => ({
  ...rest,
  amountMinor: amount,
  balanceAfterMinor: balanceAfter,
  heldAfterMinor: heldAfter,
});

const getWalletSummary = async (userId: string) => {
  const wallet = await getOrCreateWallet(userId);

  return {
    id: wallet.id,
    currency: wallet.currency,
    isFrozen: wallet.isFrozen,
    balanceMinor: wallet.balance,
    heldBalanceMinor: wallet.heldBalance,
    availableMinor: availableOf(wallet),
  };
};

const getMyTransactions = async (userId: string, query: any) => {
  const { page = 1, limit = 20, type } = query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const wallet = await getOrCreateWallet(userId);

  const where: Prisma.WalletTransactionWhereInput = { walletId: wallet.id };
  if (type) where.type = type as WalletTxType;

  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { createdAt: "desc" },
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  return {
    meta: { page: pageNum, limit: limitNum, total },
    data: transactions.map(serializeTransaction),
  };
};

/**
 * The manual credit/debit an admin uses to correct a wallet - and, before the
 * gateway exists, to fund a test account and exercise the whole deposit flow.
 * The ledger row is the audit trail, so the reason and the acting admin are
 * recorded on it rather than being left to a log line.
 */
const adminAdjust = async (
  adminUserId: string,
  payload: { userId: string; amountMinor: number; reason: string },
) => {
  const reason = payload.reason?.trim();

  if (!reason) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "A reason is required for a manual adjustment",
    );
  }

  if (!Number.isInteger(payload.amountMinor) || payload.amountMinor === 0) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "Adjustment amount must be a non-zero whole number of poisha",
    );
  }

  const user = await prisma.user.findFirst({
    where: { id: payload.userId, isDeleted: false },
    select: { id: true },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, "User not found");
  }

  const transaction = await mutate({
    userId: payload.userId,
    type: WalletTxType.ADJUSTMENT,
    amount: payload.amountMinor,
    description: `Admin adjustment: ${reason}`,
    referenceType: "ADJUSTMENT",
    referenceId: adminUserId,
    metadata: { adminUserId, reason },
  });

  return serializeTransaction(transaction);
};

/**
 * `balance` is a cache of the ledger. This proves it still agrees: the balance
 * must equal the sum of every transaction, and heldBalance must equal the most
 * recent row's `heldAfter`. Drift means something wrote outside `mutate`.
 */
const findDrift = async () => {
  const drifted = await prisma.$queryRaw<
    Array<{
      walletId: string;
      userId: string;
      balance: number;
      ledgerBalance: number;
      heldBalance: number;
    }>
  >`
    SELECT
      w.id            AS "walletId",
      w."userId"      AS "userId",
      w.balance       AS "balance",
      COALESCE(SUM(t.amount), 0)::int AS "ledgerBalance",
      w."heldBalance" AS "heldBalance"
    FROM wallets w
    LEFT JOIN wallet_transactions t ON t."walletId" = w.id
    GROUP BY w.id
    HAVING w.balance <> COALESCE(SUM(t.amount), 0)::int
  `;

  return drifted;
};

export const WalletService = {
  mutate,
  getOrCreateWallet,
  availableOf,
  holdDeposit,
  releaseDeposit,
  applyDeposit,
  forfeitDeposit,
  getWalletSummary,
  getMyTransactions,
  adminAdjust,
  findDrift,
};
