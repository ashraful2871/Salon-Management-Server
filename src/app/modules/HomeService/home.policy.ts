import { SITE_NAME } from "../../utils/brand";
import { formatBDT } from "../../utils/money";
import { getSettingWithVersion } from "../../utils/settings";

/**
 * The customer cancellation policy in force and the disclaimer a customer
 * accepts before paying. Shared by the quote, the booking snapshot, the
 * cancel rules (Phase 8) and the frontend mirror (Phase 10). A booking keeps
 * its own `policySnapshot`; nothing here ever reprices an existing one.
 */

export type HomePolicyName = "FREE" | "WINDOW" | "NON_REFUNDABLE";
export type DisclaimerLang = "en" | "bn";

export type HomePolicy = {
  policy: HomePolicyName;
  /** Changes whenever any key below is saved (see `currentPolicy`). */
  version: number;
  freeCancelHours: number;
  lateCancelPercent: number;
  noShowPercent: number;
  nonRefundableGraceMinutes: number;
  salonCancelCreditMinor: number;
  feeSalonSharePercent: number;
  appealWindowHours: number;
  maxRescheduleCount: number;
};

type Overrides = Record<HomePolicyName, string>;

/**
 * `version` is the sum of the row versions of every key that shapes what the
 * customer agrees to (the disclaimer overrides included). Row versions are
 * per key, so a max would miss a change to a key that is behind another one;
 * the sum moves on every save.
 */
export const currentPolicy = async (): Promise<HomePolicy & { overrides: Overrides }> => {
  const [
    policy,
    freeCancelHours,
    lateCancelPercent,
    noShowPercent,
    nonRefundableGraceMinutes,
    salonCancelCreditMinor,
    feeSalonSharePercent,
    appealWindowHours,
    maxRescheduleCount,
    free,
    window,
    nonRefundable,
  ] = await Promise.all([
    getSettingWithVersion("homeService.customerCancelPolicy"),
    getSettingWithVersion("homeService.freeCancelHours"),
    getSettingWithVersion("homeService.lateCancelPercent"),
    getSettingWithVersion("homeService.noShowPercent"),
    getSettingWithVersion("homeService.nonRefundableGraceMinutes"),
    getSettingWithVersion("homeService.salonCancelCreditMinor"),
    getSettingWithVersion("homeService.feeSalonSharePercent"),
    getSettingWithVersion("homeService.appealWindowHours"),
    getSettingWithVersion("homeService.maxRescheduleCount"),
    getSettingWithVersion("homeService.disclaimer.free"),
    getSettingWithVersion("homeService.disclaimer.window"),
    getSettingWithVersion("homeService.disclaimer.nonRefundable"),
  ]);
  const all = [
    policy,
    freeCancelHours,
    lateCancelPercent,
    noShowPercent,
    nonRefundableGraceMinutes,
    salonCancelCreditMinor,
    feeSalonSharePercent,
    appealWindowHours,
    maxRescheduleCount,
    free,
    window,
    nonRefundable,
  ];
  return {
    policy: policy.value,
    version: all.reduce((s, k) => s + k.version, 0),
    freeCancelHours: freeCancelHours.value,
    lateCancelPercent: lateCancelPercent.value,
    noShowPercent: noShowPercent.value,
    nonRefundableGraceMinutes: nonRefundableGraceMinutes.value,
    salonCancelCreditMinor: salonCancelCreditMinor.value,
    feeSalonSharePercent: feeSalonSharePercent.value,
    appealWindowHours: appealWindowHours.value,
    maxRescheduleCount: maxRescheduleCount.value,
    overrides: { FREE: free.value.trim(), WINDOW: window.value.trim(), NON_REFUNDABLE: nonRefundable.value.trim() },
  };
};

/** The snapshot stored on a booking: the policy without the admin's text overrides. */
export const policySnapshotOf = (p: HomePolicy & { overrides?: Overrides }): HomePolicy => {
  const { overrides: _overrides, ...snapshot } = p;
  return snapshot;
};

const pctOf = (minor: number, percent: number) => Math.round((minor * percent) / 100);

const reschedule = (n: number, lang: DisclaimerLang) => {
  if (n <= 0) return "";
  if (lang === "bn") return n === 1 ? " আপনি একবার সময় পরিবর্তন করতে পারবেন।" : ` আপনি ${n} বার সময় পরিবর্তন করতে পারবেন।`;
  return n === 1 ? " You can reschedule once." : ` You can reschedule up to ${n} times.`;
};

const generated = (p: HomePolicy, advanceMinor: number, lang: DisclaimerLang): string => {
  const x = formatBDT(advanceMinor);
  const n = p.noShowPercent;
  const noShow =
    n > 0
      ? lang === "bn"
        ? ` আপনি বাসায় না থাকলে ${n}% রেখে দেওয়া হবে।`
        : ` If you are not home, ${n}% is kept.`
      : "";

  if (p.policy === "FREE") {
    return lang === "bn"
      ? `ফ্রি বাতিল: ভিজিটের আগে যেকোনো সময় বাতিল করলে আপনার ${x} অগ্রিম ওয়ালেটে ফেরত আসবে।${noShow}`
      : `Free cancellation: cancel any time before the visit and your ${x} advance comes back to your wallet.${noShow}`;
  }

  if (p.policy === "WINDOW") {
    const h = p.freeCancelHours;
    const y = formatBDT(pctOf(advanceMinor, p.lateCancelPercent));
    return lang === "bn"
      ? `ভিজিটের ${h} ঘণ্টা আগে পর্যন্ত ফ্রি বাতিল। এরপর বাতিল করলে আপনার অগ্রিমের ${p.lateCancelPercent}% (${y}) ফেরতযোগ্য নয়।${noShow}`
      : `Free cancellation until ${h} hours before the visit. After that, ${p.lateCancelPercent}% of your advance (${y}) is non-refundable.${noShow}`;
  }

  const g = p.nonRefundableGraceMinutes;
  const grace =
    g > 0
      ? lang === "bn"
        ? ` পেমেন্টের ${g} মিনিটের মধ্যে মত বদলালে এবং ভিজিট অন্তত ${p.freeCancelHours} ঘণ্টা পরে হলে, তখনও ফ্রি বাতিল করতে পারবেন।`
        : ` If you change your mind within ${g} minutes of paying and the visit is at least ${p.freeCancelHours} hours away, you can still cancel for free.`
      : "";
  return lang === "bn"
    ? `${x} অগ্রিম বাতিল করলে বা আপনি বাসায় না থাকলে ফেরতযোগ্য নয়।${reschedule(p.maxRescheduleCount, lang)} সেলুন বা ${SITE_NAME} বাতিল করলে পুরো টাকা ফেরত পাবেন।${grace}`
    : `This advance of ${x} is non-refundable if you cancel or are not home.${reschedule(p.maxRescheduleCount, lang)} If the salon or ${SITE_NAME} cancels, you get the full amount back.${grace}`;
};

/** The admin's `disclaimer.<policy>` text when set (one text, both languages), else the generated one. */
export const buildDisclaimer = (
  p: HomePolicy & { overrides?: Overrides },
  advanceMinor: number,
  lang: DisclaimerLang,
): string => p.overrides?.[p.policy] || generated(p, advanceMinor, lang);

export const disclaimersOf = (p: HomePolicy & { overrides?: Overrides }, advanceMinor: number) => ({
  en: buildDisclaimer(p, advanceMinor, "en"),
  bn: buildDisclaimer(p, advanceMinor, "bn"),
});

/** Nothing to agree to only when the advance always comes back. */
export const requiresAcceptance = (p: Pick<HomePolicy, "policy" | "noShowPercent">) =>
  !(p.policy === "FREE" && p.noShowPercent === 0);
