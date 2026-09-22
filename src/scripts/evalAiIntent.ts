/**
 * Offline checks for how AI search reads a query - no database, no Gemini.
 *
 *   npm run ai:eval
 *
 * Each case pins what the rules must extract. Add a case whenever a real
 * query is misread, before fixing it, so the fix stays fixed. Exits non-zero
 * on any failure.
 */
import { parseRulesForTest } from "../app/modules/AI-Suggestion/ai.intent";

// Mirrors the areas that had salons when this was written.
const PLACES = [
  ["Mirpur", "Dhaka", "Dhaka", "Dhaka"],
  ["Dhanmondi", "Dhaka", "Dhaka", "Dhaka"],
  ["Gulshan", "Dhaka", "Dhaka", "Dhaka"],
  ["Banani", "Dhaka", "Dhaka", "Dhaka"],
  ["Uttara", "Dhaka", "Dhaka", "Dhaka"],
  ["Khilgaon", "Dhaka", "Dhaka", "Dhaka"],
  ["Agrabad", "Chittagong", "Chittagong", "Chittagong"],
  ["GEC", "Chittagong", "Chittagong", "Chittagong"],
  ["Zindabazar", "Sylhet", "Sylhet", "Sylhet"],
  ["Kotwali", "Sylhet", "Sylhet", "Sylhet"],
  ["Shib Bari", "Khulna", "Khulna", "Khulna"],
  ["Shaheb Bazar", "Rajshahi", "Rajshahi", "Rajshahi"],
].map(([area, district, city, division]) => ({ area, district, city, division }));

type Expect = {
  categories?: string[];
  place?: string | null;
  nearMe?: boolean;
  maxPriceMinor?: number | null;
  minPriceMinor?: number | null;
  budget?: boolean;
  minRating?: number | null;
  sortBy?: string;
  openNow?: boolean;
  terms?: string[];
  /** Whether the model would be asked. */
  asksModel?: boolean;
};

const CASES: Array<[string, Expect]> = [
  ["Cheap haircut in Dhanmondi", { categories: ["HAIRCUT"], place: "Dhanmondi", budget: true, asksModel: false }],
  ["Bridal makeup with good reviews", { categories: ["MAKEUP"], minRating: 4, sortBy: "rating", asksModel: false }],
  ["Relaxing spa and massage near Gulshan", { categories: ["SPA", "MASSAGE"], place: "Gulshan", asksModel: false }],
  ["Hair colouring under 2000 taka", { categories: ["COLORING"], maxPriceMinor: 200000, asksModel: false }],
  ["salon near me", { categories: [], nearMe: true, place: null, asksModel: false }],
  ["Salons near me", { nearMe: true, asksModel: false }],
  ["haircut under 30 minutes", { categories: ["HAIRCUT"], maxPriceMinor: null }],
  ["facial 1,500 taka", { categories: ["FACIAL"], maxPriceMinor: 150000 }],
  ["keratin treatment between 3000 and 5000 tk", { categories: ["TREATMENT"], minPriceMinor: 300000, maxPriceMinor: 500000, terms: ["keratin"] }],
  ["amar chul kata lagbe dhanmondi te 500 takar moddhe", { categories: ["HAIRCUT"], place: "Dhanmondi", maxPriceMinor: 50000, asksModel: false }],
  ["ধানমন্ডিতে চুল কাটা ৫০০ টাকার মধ্যে", { categories: ["HAIRCUT"], place: "Dhanmondi", maxPriceMinor: 50000 }],
  ["best barber in ctg", { categories: ["HAIRCUT"], sortBy: "rating", place: "Chittagong" }],
  ["nail art open now", { categories: ["MANICURE"], openNow: true }],
  ["4+ stars facial in Uttara", { categories: ["FACIAL"], minRating: 4, place: "Uttara" }],
  ["4★ facial", { categories: ["FACIAL"], minRating: 4 }],
  ["hair spa", { categories: ["TREATMENT"] }],
  ["foot massage", { categories: ["MASSAGE"] }],
  ["wedding hair and makeup", { categories: ["STYLING", "MAKEUP"] }],
  ["nearest salon for beard trim", { categories: ["HAIRCUT"], nearMe: true, sortBy: "distance" }],
  ["salon within 5 km", { maxPriceMinor: null }],
  ["cheapest haircut in Mirpur", { categories: ["HAIRCUT"], budget: true, sortBy: "price", place: "Mirpur" }],
  ["haircut 2k", { categories: ["HAIRCUT"], maxPriceMinor: 200000 }],
  ["spa treatment in Kotwali, Sylhet", { categories: ["SPA"], place: "Kotwali, Sylhet" }],
  ["Salon in Dhaka", { place: "Dhaka", asksModel: false }],
  ["spa in Bashundhara", { categories: ["SPA"], place: null, asksModel: true }],
  ["my hair is frizzy and damaged", { categories: ["TREATMENT"] }],
  ["threading and waxing in Banani", { categories: ["WAXING"], place: "Banani" }],
  ["rating above 4.5 makeup artist", { categories: ["MAKEUP"], minRating: 4.5 }],
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (values: string[]) => [...values].sort();

let failures = 0;

for (const [query, expected] of CASES) {
  const { intent, leftover } = parseRulesForTest(query, PLACES);
  const actual = {
    categories: sorted(intent.categories),
    place: intent.place?.label ?? null,
    nearMe: intent.nearMe,
    maxPriceMinor: intent.maxPriceMinor,
    minPriceMinor: intent.minPriceMinor,
    budget: intent.budget,
    minRating: intent.minRating,
    sortBy: intent.sortBy,
    openNow: intent.openNow,
    asksModel: leftover.length > 0,
  };

  const problems: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    if (key === "terms") {
      const missingTerms = (want as string[]).filter((t) => !intent.serviceTerms.includes(t));
      if (missingTerms.length) problems.push(`terms missing ${missingTerms.join(", ")}`);
      continue;
    }
    const got = actual[key as keyof typeof actual];
    const wantValue = key === "categories" ? sorted(want as string[]) : want;
    if (!same(got, wantValue)) {
      problems.push(`${key}: expected ${JSON.stringify(wantValue)}, got ${JSON.stringify(got)}`);
    }
  }

  if (problems.length) {
    failures += 1;
    console.log(`FAIL  ${query}\n      ${problems.join("\n      ")}\n      leftover: ${JSON.stringify(leftover)}`);
  } else {
    console.log(`ok    ${query}`);
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} passed`);
process.exit(failures ? 1 : 0);
