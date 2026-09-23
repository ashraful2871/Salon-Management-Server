import { PaymentIntentService } from "../modules/Payment/paymentIntent.service";
import { AppointmentCheckout } from "../modules/Appointment/appointment.checkout";
import { AppointmentDeposit } from "../modules/Appointment/appointment.deposit";
import { WalletService } from "../modules/Wallet/wallet.service";
import { syncSearchIndex } from "../modules/AI-Suggestion/ai.indexer";
import { sendBookingReminders } from "../modules/Assistant/assistant.reminders";

/**
 * Periodic money work, plus the AI search index repair.
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
const STALE_CHECKOUT_INTERVAL_MS = 30 * MINUTE;
const WALLET_AUDIT_INTERVAL_MS = 6 * HOUR;
const AI_INDEX_INTERVAL_MS = 10 * MINUTE;
// Not hourly: the 2-hour reminder's window is 30 minutes wide, and an hourly
// run would step straight over half the bookings. Running more often is free
// of risk — each reminder is claimed by its stamp, so it still sends once.
const REMINDER_INTERVAL_MS = 15 * MINUTE;

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

  // Arrival is an explicit check-in at the counter, so nothing starts a booking
  // on the clock. Bookings nobody checked in become no-shows; ones that were
  // checked in but never completed are closed as completed instead.
  every(NO_SHOW_INTERVAL_MS, "deposit.autoNoShow", () =>
    AppointmentDeposit.autoMarkNoShows(),
  );

  every(STALE_CHECKOUT_INTERVAL_MS, "appointment.autoCloseStale", () =>
    AppointmentCheckout.autoCloseStaleCheckIns(),
  );

  every(WALLET_AUDIT_INTERVAL_MS, "wallet.audit", auditWallets);

  // Embeds salons that are new, changed, or were missed when Gemini was down.
  // Writes re-embed straight away; this is the net under them.
  every(AI_INDEX_INTERVAL_MS, "ai.syncIndex", () => syncSearchIndex());

  // 24 h and 2 h email reminders for CONFIRMED bookings, once each.
  every(REMINDER_INTERVAL_MS, "assistant.reminders", () =>
    sendBookingReminders(),
  );

  // Catch anything that got stuck while the process was down, but not in the
  // first seconds of boot - a restart loop should not hammer the gateway.
  const warmup = setTimeout(() => {
    void safely("payment.reconcile", () =>
      PaymentIntentService.reconcilePendingIntents(),
    );
  }, 2 * MINUTE);
  warmup.unref?.();

  // Sooner than the payment warm-up: a salon missing from the index is
  // invisible to every AI search until this runs.
  const indexWarmup = setTimeout(() => {
    void safely("ai.syncIndex", () => syncSearchIndex());
  }, 45 * 1000);
  indexWarmup.unref?.();

  console.log("[jobs] background jobs started");
};
