import { PaymentIntentService } from "../modules/Payment/paymentIntent.service";
import { AppointmentDeposit } from "../modules/Appointment/appointment.deposit";
import { WalletService } from "../modules/Wallet/wallet.service";

/**
 * Periodic money work.
 *
 * Every job here is idempotent - top-ups are keyed by transaction id, deposit
 * outcomes by appointment id - so if this process is running on more than one
 * instance, the duplicate run is harmless rather than a double charge. Set
 * DISABLE_BACKGROUND_JOBS=true to turn them off (for a worker split, or in a
 * local process you do not want reaching the gateway).
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const RECONCILE_INTERVAL_MS = HOUR;
const NO_SHOW_INTERVAL_MS = 10 * MINUTE;
const WALLET_AUDIT_INTERVAL_MS = 6 * HOUR;

/** A job that throws must never take the server down with it. */
const safely = async (name: string, run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    console.error(`[jobs] ${name} failed`, error);
  }
};

const every = (
  intervalMs: number,
  name: string,
  run: () => Promise<unknown>,
) => {
  const timer = setInterval(() => void safely(name, run), intervalMs);
  // Do not hold the event loop open just for a timer.
  timer.unref?.();
  return timer;
};

const auditWallets = async () => {
  const drifted = await WalletService.findDrift();

  if (drifted.length) {
    console.error(
      `[jobs] wallet.audit: ${drifted.length} wallet(s) no longer match their ledger`,
      drifted,
    );
  }
};

export const startBackgroundJobs = () => {
  if (process.env.DISABLE_BACKGROUND_JOBS === "true") {
    console.log("[jobs] background jobs disabled");
    return;
  }

  every(RECONCILE_INTERVAL_MS, "payment.reconcile", () =>
    PaymentIntentService.reconcilePendingIntents(),
  );

  every(NO_SHOW_INTERVAL_MS, "deposit.autoNoShow", () =>
    AppointmentDeposit.autoMarkNoShows(),
  );

  every(WALLET_AUDIT_INTERVAL_MS, "wallet.audit", auditWallets);

  // Catch anything that got stuck while the process was down, but not in the
  // first seconds of boot - a restart loop should not hammer the gateway.
  const warmup = setTimeout(() => {
    void safely("payment.reconcile", () =>
      PaymentIntentService.reconcilePendingIntents(),
    );
  }, 2 * MINUTE);
  warmup.unref?.();

  console.log("[jobs] background money jobs started");
};
