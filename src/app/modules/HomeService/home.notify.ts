import { CancelledBy, HomeBookingStatus, HomeNoShowParty } from "@prisma/client";
import config from "../../../config";
import prisma from "../../shared/prisma";
import { sendEmail } from "../../utils/emailSender";
import { getHomeServiceDecisionTemplate, getHomeVisitTemplate } from "../../utils/emailTemplates";
import { formatBDT } from "../../utils/money";
import { branchRecipients, notify, NotifyEvent, NotifyPayload } from "../../utils/notify";
import { SITE_NAME } from "../../utils/brand";
import type { Outcome } from "./home.cancel";
import { snapshotOf } from "./home.cancel";
import { hmacCode } from "./home.lifecycle";

/**
 * Who hears about a home visit, and how. Called after the transaction that
 * changed the visit has committed; never throws (a mail or bell problem must
 * never fail the booking, cancel or settlement it reports).
 *
 * - Customer: transactional emails sent directly (not preference-gated), and
 *   a bell row when the expert sets off / arrives.
 * - Expert: bell rows (their staff user).
 * - Branch: bell rows for the owner and members per `branchRecipients`
 *   (email only where they turned it on).
 */

/** Frontend paths. Phases 12–14 build these pages. */
export const HOME_PATHS = {
  customerBooking: (id: string) => `/home-service/booking/${id}`,
  expertJob: (id?: string) => (id ? `/dashboard/home-jobs?id=${id}` : "/dashboard/home-jobs"),
  ownerBoard: (salonId: string) => `/dashboard/home-service/bookings?salonId=${salonId}`,
  ownerHome: (salonId: string) => `/dashboard/home-service?salonId=${salonId}`,
};

export type HomeNotice =
  | { kind: "confirmed" }
  | { kind: "reminder"; when: "24h" | "2h" }
  | { kind: "en_route" }
  | { kind: "arrived" }
  | { kind: "completed" }
  | { kind: "ended"; outcome: Outcome; balanceReleasedMinor: number }
  | { kind: "reassigned"; fromExpertId: string }
  | { kind: "appeal"; approved: boolean; refundedMinor: number };

const ROW = {
  id: true,
  code: true,
  status: true,
  audience: true,
  startAt: true,
  endAt: true,
  area: true,
  addressLine: true,
  salonId: true,
  customerId: true,
  expertId: true,
  totalMinor: true,
  advanceMinor: true,
  balanceMinor: true,
  balanceMethod: true,
  balanceCollectedMinor: true,
  feeMinor: true,
  cancelledBy: true,
  cancelReason: true,
  noShowParty: true,
  disclaimerText: true,
  policySnapshot: true,
  customer: { select: { name: true, email: true } },
  salon: { select: { name: true, phone: true } },
  expert: { select: { staff: { select: { userId: true, user: { select: { name: true } } } } } },
  items: { select: { nameSnapshot: true } },
} as const;

const when = (d: Date) =>
  d.toLocaleString("en-GB", {
    timeZone: "Asia/Dhaka",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "Your expert";
const url = (path: string) => `${config.frontend_url}${path}`;

/** The start code, or null when the secret is missing (the email still goes, without it). */
const codeOf = (id: string) => {
  try {
    return hmacCode(id);
  } catch {
    return null;
  }
};

const expertUserOf = async (expertId: string) =>
  (await prisma.homeExpert.findUnique({ where: { id: expertId }, select: { staff: { select: { userId: true } } } }))?.staff
    .userId ?? null;

/** The branch's people plus the expert, in one call so nobody is told twice. */
const toBranchAndExpert = async (salonId: string, expertUserId: string | null, event: NotifyEvent, payload: NotifyPayload) => {
  const ids = await branchRecipients(salonId).catch(() => [] as string[]);
  return notify([...ids, expertUserId], event, { salonId, ...payload });
};

const toBranch = async (salonId: string, event: NotifyEvent, payload: NotifyPayload) => {
  const ids = await branchRecipients(salonId).catch(() => [] as string[]);
  return notify(ids, event, { salonId, ...payload });
};

const emailCustomer = async (to: string | null | undefined, subject: string, html: string) => {
  if (!to) return;
  await sendEmail(to, subject, html);
};

/** Sends everything one change of a visit calls for. Never throws. */
export const notifyHomeBooking = async (bookingId: string, n: HomeNotice) => {
  try {
    const b = await prisma.homeBooking.findUnique({ where: { id: bookingId }, select: ROW });
    if (!b) return;
    const expertName = b.expert.staff.user.name;
    const expertUserId = b.expert.staff.userId;
    const services = b.items.map((i) => i.nameSnapshot).join(", ");
    const at = when(b.startAt);
    const name = b.customer.name || "there";
    const myVisit = { label: "View your visit", url: url(HOME_PATHS.customerBooking(b.id)) };
    const visitRows: [string, string][] = [
      ["Booking", b.code],
      ["When", at],
      ["Expert", expertName],
      ["Services", services],
      ["Salon", b.salon.name],
    ];
    const jobLink = HOME_PATHS.expertJob(b.id);
    const boardLink = HOME_PATHS.ownerBoard(b.salonId);

    switch (n.kind) {
      case "confirmed": {
        const code = codeOf(b.id);
        await emailCustomer(
          b.customer.email,
          `Home visit ${b.code} confirmed: ${at}`,
          getHomeVisitTemplate({
            heading: "Your home visit is booked",
            name,
            lines: [
              `${expertName} from ${b.salon.name} will come to you on ${at}.`,
              `Your ${formatBDT(b.advanceMinor)} advance is held by ${SITE_NAME}; the salon is paid after the visit. ${
                b.balanceMinor > 0 ? `${formatBDT(b.balanceMinor)} is left to pay on the day.` : ""
              }`.trim(),
            ],
            highlight: code
              ? { label: "Start code", value: code, note: "Read it to your expert when they arrive, not before." }
              : null,
            rows: [...visitRows, ["Address", b.addressLine], ["Total", formatBDT(b.totalMinor)], ["Advance paid", formatBDT(b.advanceMinor)]],
            disclaimer: b.disclaimerText,
            cta: myVisit,
          }),
        );
        await toBranchAndExpert(b.salonId, expertUserId, "home.booking.confirmed", {
          title: `Home visit ${b.code} booked`,
          body: `${firstName(expertName)} · ${at} · ${services}. ${formatBDT(b.advanceMinor)} advance held — paid to you after the visit.`,
          link: boardLink,
          dedupeKey: `home.booking.confirmed:${b.id}`,
        });
        return;
      }

      case "reminder": {
        const soon = n.when === "24h" ? "tomorrow" : "in about 2 hours";
        await emailCustomer(
          b.customer.email,
          `Reminder: your home visit ${soon} (${b.code})`,
          getHomeVisitTemplate({
            heading: n.when === "24h" ? "Your home visit is tomorrow" : "Your home visit is in 2 hours",
            name,
            lines: [
              `${expertName} is coming ${soon}, at ${at}.`,
              "Keep your start code ready: it is on your visit page, and your expert needs it to begin.",
            ],
            rows: [...visitRows, ["Address", b.addressLine], ["Left to pay", formatBDT(b.balanceMinor)]],
            cta: myVisit,
          }),
        );
        await notify([expertUserId], "home.booking.reminder", {
          title: `Home visit ${soon}: ${b.code}`,
          body: `${at} · ${b.area ?? "address shown 2 hours before"} · ${services}`,
          link: jobLink,
          salonId: b.salonId,
          // A rescheduled visit is reminded again.
          dedupeKey: `home.booking.reminder:${b.id}:${n.when}:${b.startAt.getTime()}`,
        });
        return;
      }

      case "en_route":
      case "arrived": {
        const onWay = n.kind === "en_route";
        await notify([b.customerId], "home.booking.on_the_way", {
          title: onWay ? `${firstName(expertName)} is on the way` : `${firstName(expertName)} has arrived`,
          body: onWay
            ? `Your expert for ${b.code} has set off. Keep your start code ready.`
            : "Your expert is at your door. Read them your start code to begin.",
          link: HOME_PATHS.customerBooking(b.id),
          dedupeKey: `home.booking.on_the_way:${b.id}:${n.kind}`,
        });
        return;
      }

      case "completed": {
        const paidInApp = b.balanceMethod === "WALLET";
        await emailCustomer(
          b.customer.email,
          `Receipt for your home visit ${b.code}`,
          getHomeVisitTemplate({
            heading: "Thanks — your visit is complete",
            name,
            lines: [`${expertName} finished your visit. Here is your receipt.`, "How did it go? A short review helps other customers choose."],
            rows: [
              ["Booking", b.code],
              ["Date", at],
              ["Services", services],
              ["Total", formatBDT(b.totalMinor)],
              ["Advance (wallet)", formatBDT(b.advanceMinor)],
              [
                paidInApp ? "Balance (wallet)" : "Balance paid to the expert",
                formatBDT(paidInApp ? b.balanceMinor : (b.balanceCollectedMinor ?? 0)),
              ],
            ],
            cta: { label: "Rate your expert", url: url(`${HOME_PATHS.customerBooking(b.id)}?review=1`) },
          }),
        );
        const toSalon = b.advanceMinor + (paidInApp ? b.balanceMinor : 0);
        await toBranch(b.salonId, "home.booking.completed", {
          title: `Home visit ${b.code} completed`,
          body: `${firstName(expertName)} · ${services}. ${formatBDT(toSalon)} added to your pending balance.`,
          link: boardLink,
          dedupeKey: `home.booking.completed:${b.id}`,
        });
        return;
      }

      case "ended": {
        const o = n.outcome;
        const back = o.refundMinor + n.balanceReleasedMinor;
        const noShow = b.status === HomeBookingStatus.NO_SHOW;
        const event: NotifyEvent = noShow ? "home.booking.no_show" : "home.booking.cancelled";
        const who =
          noShow
            ? b.noShowParty === HomeNoShowParty.EXPERT
              ? "Your expert didn't arrive, so the visit was cancelled."
              : "Your expert waited at the address but couldn't reach you, so the visit was marked as missed."
            : b.cancelledBy === CancelledBy.CUSTOMER
              ? "You cancelled this visit."
              : b.cancelledBy === CancelledBy.SALON
                ? `${b.salon.name} cancelled this visit.`
                : "We cancelled this visit.";
        const lines = [who];
        if (o.reasonCode === "NOT_PAID") lines.push("Nothing was paid for it, so nothing was charged.");
        else {
          if (back > 0) lines.push(`${formatBDT(back)} is back in your wallet.`);
          if (o.salonCreditMinor > 0) lines.push(`${b.salon.name} added ${formatBDT(o.salonCreditMinor)} to your wallet for the trouble.`);
          if (o.feeMinor > 0) {
            const hours = snapshotOf(b.policySnapshot).appealWindowHours;
            lines.push(
              `${formatBDT(o.feeMinor)} of your ${formatBDT(b.advanceMinor)} advance was kept under the cancellation policy you accepted.`,
              `If you think that's wrong, you can appeal within ${hours} hours from your visit page.`,
            );
          }
        }
        await emailCustomer(
          b.customer.email,
          noShow ? `Home visit ${b.code} missed` : `Home visit ${b.code} cancelled`,
          getHomeVisitTemplate({
            heading: noShow ? "Your home visit didn't happen" : "Your home visit is cancelled",
            name,
            lines,
            rows: visitRows,
            cta: o.feeMinor > 0 ? { label: "Appeal", url: url(`${HOME_PATHS.customerBooking(b.id)}?appeal=1`) } : myVisit,
          }),
        );
        const salonLine =
          o.feeMinor > 0 ? `${formatBDT(o.salonShareMinor)} of the kept fee goes to you.` : "The customer was refunded in full.";
        await toBranchAndExpert(b.salonId, expertUserId, event, {
          title: noShow
            ? b.noShowParty === HomeNoShowParty.EXPERT
              ? `Expert didn't arrive: ${b.code}`
              : `Customer not home: ${b.code}`
            : `Home visit ${b.code} cancelled`,
          body: `${at} · ${firstName(expertName)}. ${salonLine}`,
          link: boardLink,
          dedupeKey: `${event}:${b.id}`,
        });
        return;
      }

      case "reassigned": {
        await emailCustomer(
          b.customer.email,
          `New expert for your home visit ${b.code}`,
          getHomeVisitTemplate({
            heading: "Your visit has a new expert",
            name,
            lines: [`${expertName} from ${b.salon.name} will now do your visit at ${at}. Nothing else changes, and your start code is the same.`],
            rows: visitRows,
            cta: myVisit,
          }),
        );
        const fromUserId = await expertUserOf(n.fromExpertId);
        await notify([expertUserId], "home.booking.reassigned", {
          title: `New home visit for you: ${b.code}`,
          body: `${at} · ${services}`,
          link: jobLink,
          salonId: b.salonId,
        });
        await notify([fromUserId], "home.booking.reassigned", {
          title: `Home visit ${b.code} moved to another expert`,
          body: `${at} is off your list.`,
          link: HOME_PATHS.expertJob(),
          salonId: b.salonId,
        });
        return;
      }

      case "appeal": {
        const event: NotifyEvent = b.noShowParty ? "home.booking.no_show" : "home.booking.cancelled";
        await emailCustomer(
          b.customer.email,
          n.approved ? `Your appeal for ${b.code} was upheld` : `Your appeal for ${b.code} was not upheld`,
          getHomeVisitTemplate({
            heading: n.approved ? "Appeal upheld" : "Appeal not upheld",
            name,
            lines: n.approved
              ? [`We agreed with your appeal. ${formatBDT(n.refundedMinor)} is back in your wallet.`]
              : ["We looked at your appeal and the fee stands under the policy you accepted."],
            rows: visitRows,
            cta: myVisit,
            footnote: n.approved ? null : "If you have something new to add, reply through the Contact page and quote your booking code.",
          }),
        );
        await toBranchAndExpert(b.salonId, expertUserId, event, {
          title: n.approved ? `Appeal upheld: ${b.code}` : `Appeal rejected: ${b.code}`,
          body: n.approved
            ? `The kept fee (${formatBDT(n.refundedMinor)}) was returned to the customer, including your share.`
            : "The fee stands.",
          link: boardLink,
          dedupeKey: `home.booking.appeal:${b.id}`,
        });
        return;
      }
    }
  } catch (err) {
    console.error(`[home] notify ${n.kind} ${bookingId} failed`, (err as Error)?.message ?? err);
  }
};

/** Fire-and-forget for request handlers: after the commit, never awaited, never throws. */
export const homeNotice = (bookingId: string, n: HomeNotice) => {
  void notifyHomeBooking(bookingId, n);
};

// ---------------------------------------------------------------------------
// Owner: admin decisions on the branch and its experts
// ---------------------------------------------------------------------------

export type DecisionKind = Parameters<typeof getHomeServiceDecisionTemplate>[0]["kind"];

const DECISIONS: Record<DecisionKind, { event: NotifyEvent; title: (salon: string, expert: string) => string; body: string }> = {
  branch_approved: { event: "home.branch.reviewed", title: (s) => `Home Service at ${s} is live`, body: "Customers can now book your verified experts." },
  branch_rejected: { event: "home.branch.reviewed", title: (s) => `Home Service at ${s} was not approved`, body: "Fix what we listed and turn it on again." },
  branch_suspended: { event: "home.branch.reviewed", title: (s) => `Home Service at ${s} is suspended`, body: "Customers can't book home visits from this branch for now." },
  expert_verified: { event: "home.expert.verified", title: (s, e) => `${e} is verified for home visits at ${s}`, body: "They can now take home visits." },
  expert_rejected: { event: "home.expert.rejected", title: (s, e) => `${e} was not verified for home visits at ${s}`, body: "Update their documents and submit again." },
};

/** The owner hears (bell + email per prefs) about an admin decision. Fire-and-forget. */
export const notifyHomeDecision = (salonId: string, kind: DecisionKind, reason?: string | null, expertName?: string | null) => {
  void (async () => {
    try {
      const salon = await prisma.salon.findUnique({ where: { id: salonId }, select: { name: true, owner: { select: { userId: true } } } });
      if (!salon) return;
      const d = DECISIONS[kind];
      const title = d.title(salon.name, expertName ?? "Your expert");
      const link = HOME_PATHS.ownerHome(salonId);
      await notify([salon.owner.userId], d.event, {
        title,
        body: reason ? `${d.body} Reason: ${reason}` : d.body,
        link,
        salonId,
        email: {
          subject: title,
          html: (ownerName) =>
            getHomeServiceDecisionTemplate({
              kind,
              ownerName,
              salonName: salon.name,
              expertName,
              reason,
              link: url(link),
              contactUrl: url("/contact"),
            }),
        },
      });
    } catch (err) {
      console.error(`[home] owner notice ${kind} failed`, (err as Error)?.message ?? err);
    }
  })();
};
