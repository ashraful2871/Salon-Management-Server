/**
 * Table check for the referral maths (`modules/Referral/referral.math.ts`).
 *
 *   npm run referral:math
 *
 * Pure: no database, no env, no network. Each case prints ✅ or ❌; the script
 * exits 1 on any ❌. Amounts are poisha (৳1 = 100).
 */
import {
  applicability,
  bdPhone,
  CODE_ALPHABET,
  codePrefix,
  fillShareMessage,
  normalizeCode,
  normalizeEmailForSelfCheck,
  percentToBps,
  pickBest,
  rewardDiscountMinor,
  rewardLabel,
  type ApplyCtx,
  type RewardTerms,
} from "../app/modules/Referral/referral.math";

export type Eq = (name: string, got: unknown, want: unknown) => void;
export type Section = (title: string) => void;

const NOW = new Date("2026-11-19T06:00:00.000Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const reward = (over: Partial<RewardTerms> = {}): RewardTerms => ({
  id: "r1",
  kind: "REFEREE_WELCOME",
  percentBps: 500,
  maxDiscountMinor: 30_000,
  minOrderMinor: 0,
  scope: "ALL",
  firstBookingOnly: true,
  expiresAt: at(30 * DAY),
  ...over,
});

const ctx = (over: Partial<ApplyCtx> = {}): ApplyCtx => ({
  kind: "SALON",
  baseMinor: 200_000,
  completedBookings: 0,
  now: NOW,
  ...over,
});

const why = (r: RewardTerms, c: ApplyCtx) => {
  const a = applicability(r, c);
  return a.ok ? `ok:${a.discountMinor}` : a.reason;
};

/** Every case of the table; `verify:referral` runs the same ones. */
export const runMathTable = (eq: Eq, section: Section) => {
// ------------------------------------------------------------------ discount
section("Discount: rounding");
eq("৳1,234 × 5% = ৳61 (floored to the taka)", rewardDiscountMinor(123_400, 500, 0), 6_100);
eq("৳19 × 5% = 95 poisha → 0 (under ৳1)", rewardDiscountMinor(1_900, 500, 0), 0);
eq("৳20 × 5% = ৳1 exactly → applies", rewardDiscountMinor(2_000, 500, 0), 100);
eq("৳1,999 × 10% = ৳199.90 → ৳199", rewardDiscountMinor(199_900, 1_000, 0), 19_900);
eq("৳150.50 × 10% = ৳15.05 → ৳15", rewardDiscountMinor(15_050, 1_000, 0), 1_500);
eq("5.5% (550 bps) of ৳1,000 = ৳55", rewardDiscountMinor(100_000, 550, 0), 5_500);
eq("a zero or negative base → 0", [rewardDiscountMinor(0, 500, 0), rewardDiscountMinor(-5_000, 500, 0)], [0, 0]);
eq("0 bps → 0", rewardDiscountMinor(100_000, 0, 0), 0);

section("Discount: caps");
eq("friend cap ৳300: ৳10,000 × 5% = ৳500 → ৳300", rewardDiscountMinor(1_000_000, 500, 30_000), 30_000);
eq("referrer cap ৳500: ৳10,000 × 10% = ৳1,000 → ৳500", rewardDiscountMinor(1_000_000, 1_000, 50_000), 50_000);
eq("cap 0 means no cap: ৳10,000 × 10% = ৳1,000", rewardDiscountMinor(1_000_000, 1_000, 0), 100_000);
eq("base below the cap: ৳2,000 × 5% = ৳100 (cap ৳300 not reached)", rewardDiscountMinor(200_000, 500, 30_000), 10_000);
eq("discount exactly at the cap: ৳6,000 × 5% = ৳300", rewardDiscountMinor(600_000, 500, 30_000), 30_000);
eq("never more than the base (200% guard)", rewardDiscountMinor(10_000, 20_000, 0), 10_000);
eq("a cap under ৳1 leaves nothing worth applying", rewardDiscountMinor(1_000_000, 500, 50), 0);

// ------------------------------------------------------------- applicability
section("Applicability: scope × kind");
eq("ALL on a salon booking", why(reward({ scope: "ALL" }), ctx({ kind: "SALON" })), "ok:10000");
eq("ALL on a home visit", why(reward({ scope: "ALL" }), ctx({ kind: "HOME" })), "ok:10000");
eq("SALON on a salon booking", why(reward({ scope: "SALON" }), ctx({ kind: "SALON" })), "ok:10000");
eq("SALON on a home visit → SCOPE", why(reward({ scope: "SALON" }), ctx({ kind: "HOME" })), "SCOPE");
eq("HOME on a home visit", why(reward({ scope: "HOME" }), ctx({ kind: "HOME" })), "ok:10000");
eq("HOME on a salon booking → SCOPE", why(reward({ scope: "HOME" }), ctx({ kind: "SALON" })), "SCOPE");

section("Applicability: minimum order");
eq("below the minimum → MIN_ORDER", why(reward({ minOrderMinor: 50_000 }), ctx({ baseMinor: 49_900 })), "MIN_ORDER");
eq("exactly the minimum → applies", why(reward({ minOrderMinor: 50_000 }), ctx({ baseMinor: 50_000 })), "ok:2500");
eq("minimum 0 → any base that earns ৳1", why(reward({ minOrderMinor: 0 }), ctx({ baseMinor: 2_000 })), "ok:100");

section("Applicability: first-booking rule");
eq("first-booking reward, 0 completed → applies", why(reward({ firstBookingOnly: true }), ctx({ completedBookings: 0 })), "ok:10000");
eq("first-booking reward, 1 completed → FIRST_BOOKING_DONE", why(reward({ firstBookingOnly: true }), ctx({ completedBookings: 1 })), "FIRST_BOOKING_DONE");
eq("any-booking reward, 3 completed → applies", why(reward({ firstBookingOnly: false }), ctx({ completedBookings: 3 })), "ok:10000");

section("Applicability: expiry and order of reasons");
eq("now === expiresAt → EXPIRED (valid only while now < expiresAt)", why(reward({ expiresAt: NOW }), ctx()), "EXPIRED");
eq("1 ms before expiry → applies", why(reward({ expiresAt: at(1) }), ctx()), "ok:10000");
eq("after expiry → EXPIRED", why(reward({ expiresAt: at(-DAY) }), ctx()), "EXPIRED");
eq("too small → TOO_SMALL", why(reward(), ctx({ baseMinor: 1_900 })), "TOO_SMALL");
eq("expired and wrong scope → EXPIRED first", why(reward({ expiresAt: at(-1), scope: "HOME" }), ctx()), "EXPIRED");
eq(
  "first booking done and below minimum → FIRST_BOOKING_DONE (lasting reason first)",
  why(reward({ minOrderMinor: 500_000 }), ctx({ completedBookings: 2 })),
  "FIRST_BOOKING_DONE",
);

// ------------------------------------------------------------------ pickBest
section("pickBest");
const welcome = reward({ id: "w", kind: "REFEREE_WELCOME", percentBps: 500, maxDiscountMinor: 30_000, expiresAt: at(10 * DAY) });
const bonus = reward({ id: "b", kind: "REFERRER_BONUS", percentBps: 1_000, maxDiscountMinor: 50_000, firstBookingOnly: false, scope: "SALON", expiresAt: at(90 * DAY) });
const big = ctx({ baseMinor: 1_000_000 });
{
  const none = pickBest([], big);
  eq("no rewards → best null, no options", [none.best, none.options.length], [null, 0]);
  const p = pickBest([welcome, bonus], big);
  eq("largest discount wins (৳500 over ৳300)", [p.best?.reward.id, p.best?.discountMinor], ["b", 50_000]);
  eq("options sorted by discount, largest first", p.options.map((o) => o.reward.id), ["b", "w"]);

  const soon = reward({ id: "z", expiresAt: at(5 * DAY) });
  const later = reward({ id: "a", expiresAt: at(20 * DAY) });
  eq("tie on discount → earliest expiry wins", pickBest([later, soon], big).best?.reward.id, "z");

  const twinA = reward({ id: "a2" });
  const twinB = reward({ id: "b2" });
  eq("tie on discount and expiry → stable by id", [pickBest([twinB, twinA], big).best?.reward.id, pickBest([twinA, twinB], big).best?.reward.id], ["a2", "a2"]);

  const capped5 = reward({ id: "c5", percentBps: 500, maxDiscountMinor: 30_000, expiresAt: at(40 * DAY) });
  const capped10 = reward({ id: "c10", percentBps: 1_000, maxDiscountMinor: 30_000, expiresAt: at(15 * DAY) });
  eq("both capped to ৳300 → earliest expiry, not the higher percent", pickBest([capped5, capped10], big).best?.reward.id, "c10");

  const home = pickBest([welcome, bonus], ctx({ kind: "HOME", baseMinor: 1_000_000 }));
  eq(
    "inapplicable ones left out with their reason",
    [home.best?.reward.id, home.notApplicable.map((n) => `${n.reward.id}:${n.reason}`)],
    ["w", ["b:SCOPE"]],
  );
  const used = pickBest([welcome], ctx({ completedBookings: 1 }));
  eq("nothing applicable → best null", [used.best, used.notApplicable[0]?.reason], [null, "FIRST_BOOKING_DONE"]);
}

// --------------------------------------------------------------------- codes
section("Codes: normalize");
eq("lower case → upper", normalizeCode("robin7k2"), "ROBIN7K2");
eq("spaces and dashes dropped", normalizeCode("  rob-in 7k2 "), "ROBIN7K2");
eq("long dash (phone auto-correct) dropped", normalizeCode("ROBIN—7K2"), "ROBIN7K2");
eq("zero read as the letter O", normalizeCode("R0BIN7K2"), "ROBIN7K2");
eq("too short (5) → null", normalizeCode("ab-c d2"), null);
eq("6 characters is the shortest accepted", normalizeCode("ABCDE2"), "ABCDE2");
eq("13 characters → null", normalizeCode("ABCDEFGHJKMNP"), null);
eq("a 1 can't be in a code → null", normalizeCode("ABC1EFGH"), null);
eq("other punctuation → null", [normalizeCode("ROBIN_7K2"), normalizeCode("ROBIN.7K2")], [null, null]);
eq("empty → null", normalizeCode("   "), null);

section("Codes: alphabet and prefix");
eq(
  "alphabet: 32 unique, no 0 O 1 I",
  [CODE_ALPHABET.length, new Set(CODE_ALPHABET).size, /[0O1I]/.test(CODE_ALPHABET)],
  [32, 32, false],
);
eq("first name, up to 5 letters", codePrefix("Ashraful Islam"), "ASHRA");
eq("leading title skipped", [codePrefix("Md. Ashraful Islam"), codePrefix("MST Rina Akter")], ["ASHRA", "RINA"]);
eq("diacritics stripped", codePrefix("Zoë Kravitz"), "ZOE");
eq("short name kept whole", codePrefix("Al"), "AL");
eq("a title alone is still the name", codePrefix("Md"), "MD");
eq("name in Bangla → no prefix", codePrefix("আশরাফুল ইসলাম"), "");
eq("apostrophes and digits dropped", codePrefix("O'Brien2 Smith"), "OBRIE");

// ------------------------------------------------------------------ identity
section("Self-referral email");
eq("Gmail dots, +tag and case removed", normalizeEmailForSelfCheck(" A.Shraful+promo@Gmail.com "), "ashraful@gmail.com");
eq("googlemail.com is gmail.com", normalizeEmailForSelfCheck("ashraful@googlemail.com"), "ashraful@gmail.com");
eq(
  "two Gmail aliases of one inbox compare equal",
  normalizeEmailForSelfCheck("ash.raful@gmail.com") === normalizeEmailForSelfCheck("ashraful+x@gmail.com"),
  true,
);
eq("other providers: only lower-cased", normalizeEmailForSelfCheck("A.B+c@Yahoo.com"), "a.b+c@yahoo.com");

section("Phone");
eq("01XXXXXXXXX kept", bdPhone("01712345678"), "01712345678");
eq("+880 prefix", bdPhone("+8801712345678"), "01712345678");
eq("880 prefix", bdPhone("8801812345678"), "01812345678");
eq("spaces and dashes", bdPhone("+880 1712-345678"), "01712345678");
eq("operator 012 → null", bdPhone("01212345678"), null);
eq("10 digits → null", bdPhone("0171234567"), null);
eq("missing leading 0 → null", bdPhone("1712345678"), null);
eq("null / undefined / empty → null", [bdPhone(null), bdPhone(undefined), bdPhone("")], [null, null, null]);

// ------------------------------------------------------------------- display
section("Labels, percent, share text");
eq("percentToBps", [percentToBps(5), percentToBps(7.5), percentToBps(0.01)], [500, 750, 1]);
eq("welcome label", rewardLabel("REFEREE_WELCOME", 500), "Welcome reward (5%)");
eq("referrer label", rewardLabel("REFERRER_BONUS", 1_000), "Referral reward (10%)");
eq("other kinds", rewardLabel("MANUAL_GRANT", 750), "Reward (7.5%)");
const vars = { percent: 5, code: "ROBIN7K2", link: "https://example.com/r/ROBIN7K2", site: "Stylio", capMinor: 30_000 };
eq(
  "default template filled",
  fillShareMessage("Get {percent}% off your first booking on {site} with my code {code}: {link}", vars),
  "Get 5% off your first booking on Stylio with my code ROBIN7K2: https://example.com/r/ROBIN7K2",
);
eq("{cap} in taka", fillShareMessage("Up to {cap} off", vars), "Up to ৳300 off");
eq("{cap} with no cap", fillShareMessage("Up to {cap} off", { ...vars, capMinor: 0 }), "Up to no limit off");
eq("repeated placeholders all filled, unknown kept", fillShareMessage("{code} {code} {foo}", vars), "ROBIN7K2 ROBIN7K2 {foo}");
eq("decimal percent", fillShareMessage("{percent}%", { ...vars, percent: 5.5 }), "5.5%");

};

if (require.main === module) {
  let passed = 0;
  let failed = 0;
  const eq: Eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  };
  runMathTable(eq, (title) => console.log(`\n${title}`));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
