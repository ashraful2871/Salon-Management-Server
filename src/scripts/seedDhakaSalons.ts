/**
 * Replaces one owner's salons with ~590 realistic salons spread over the whole
 * of Dhaka city, each with services, counters, staff, 30 days of bookable
 * slots (some already taken), and a history of completed visits with reviews.
 * It exists so nearby search, the map and booking can be tested as if the
 * platform were live.
 *
 *   npm run seed:dhaka                        dry run: what would be deleted and created
 *   npm run seed:dhaka -- --apply             back up, delete, insert, verify
 *   npm run seed:dhaka -- --apply --owner someone@example.com
 *
 * Where each salon is comes from ./data/dhaka-salons.json, built from
 * OpenStreetMap: every pin sits on a real street, the address names that
 * street and the locality the pin is in (checked against Nominatim), and every
 * street in the city is within 1 km of a salon. Everything else - names,
 * menus, prices, staff, bookings, reviews - is generated here from fixed
 * seeds, so a re-run produces the same salons.
 *
 * What is deleted: every salon of the owner (with its services, slots,
 * bookings and reviews) and every user on SEED_EMAIL_DOMAIN. A deposit still
 * held on a deleted booking is released to the customer's wallet first, and a
 * JSON backup of the deleted salons goes to ./seed-backups/.
 *
 * Seeded customers and staff have no password (they cannot sign in) and
 * example.com addresses (sendEmail drops those). Seeded bookings carry no
 * deposit and are stamped as already reminded, so no background job emails or
 * charges anyone for them. AI-search vectors are left to the ai.syncIndex job
 * (or `npm run backfill:embeddings`).
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  AppointmentSource,
  AppointmentStatus,
  BookingChannel,
  DepositStatus,
  Gender,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ServiceCategory,
  UserRole,
  UserStatus,
} from "@prisma/client";
import "../config";
import prisma from "../app/shared/prisma";
import { settleReleasedTx } from "../app/modules/Appointment/appointment.deposit";
import { SALON_GEOG } from "../app/modules/Salon/salon.geo";

const DATA_FILE = path.join(__dirname, "data", "dhaka-salons.json");
const BACKUP_DIR = path.join(process.cwd(), "seed-backups");
const DEFAULT_OWNER = "ashrafulash2871@gmail.com";
const SEED_EMAIL_DOMAIN = "seed.example.com";

const SLOT_DAYS = 30;
const HISTORY_DAYS = 120;
const CUSTOMER_COUNT = 320;
const NEARBY_RADIUS_M = 1000;
/** Refuse to grow the database past this share of the Neon storage cap. */
const MAX_CAP_SHARE = 0.7;
/** Measured on this schema: bytes per row including indexes. */
const ROW_BYTES = { slot: 390, appointment: 900, review: 450, payment: 350, other: 600 };

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force");
const ownerFlag = args.indexOf("--owner");
const OWNER_EMAIL = (ownerFlag >= 0 ? args[ownerFlag + 1] : DEFAULT_OWNER)
  .trim()
  .toLowerCase();

// ---------------------------------------------------------------------------
// Deterministic randomness: one stream per purpose, so adding a review does
// not move every salon's name.

type Rng = () => number;

const mulberry32 = (seed: number): Rng => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const rngFor = (key: string): Rng => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return mulberry32(h >>> 0);
};

const int = (r: Rng, min: number, max: number) => min + Math.floor(r() * (max - min + 1));
const pick = <T>(r: Rng, items: readonly T[]): T => items[Math.floor(r() * items.length)];
const chance = (r: Rng, p: number) => r() < p;
const shuffle = <T>(r: Rng, items: readonly T[]): T[] => {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const weighted = <T>(r: Rng, entries: readonly (readonly [T, number])[]): T => {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let x = r() * total;
  for (const [value, w] of entries) {
    x -= w;
    if (x < 0) return value;
  }
  return entries[entries.length - 1][0];
};
/** Roughly normal, mean 0, sd 1. */
const gauss = (r: Rng) => (r() + r() + r() + r() + r() + r() - 3) / 0.7071;

// ---------------------------------------------------------------------------
// Time. Slots store a calendar day (UTC midnight) and a wall-clock "HH:MM";
// wall clock here means Dhaka.

const DAY_MS = 24 * 60 * 60 * 1000;
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const nowMs = Date.now();
const dhakaNow = new Date(nowMs + DHAKA_OFFSET_MS);
const TODAY = Date.UTC(dhakaNow.getUTCFullYear(), dhakaNow.getUTCMonth(), dhakaNow.getUTCDate());
const NOW_MINUTE = dhakaNow.getUTCHours() * 60 + dhakaNow.getUTCMinutes();

const pad2 = (n: number) => String(n).padStart(2, "0");
const hhmm = (minute: number) => `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
const toMinute = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};
const dayOf = (offset: number) => new Date(TODAY + offset * DAY_MS);
const isoDay = (offset: number) => dayOf(offset).toISOString().slice(0, 10);
/** The instant a Dhaka wall-clock time happens. */
const dhakaInstant = (dayMs: number, minute: number) =>
  new Date(dayMs + minute * 60 * 1000 - DHAKA_OFFSET_MS);

// ---------------------------------------------------------------------------
// Catalogues

type SalonType = "GENTS" | "LADIES" | "UNISEX" | "SPA";
type Tier = 1 | 2 | 3 | 4;

type Location = {
  locality: string;
  area: string;
  zip: string;
  tier: Tier;
  lat: number;
  lng: number;
  road: string | null;
  mainRoad: boolean;
};

const TYPE_MIX: Record<Tier, readonly (readonly [SalonType, number])[]> = {
  1: [["LADIES", 35], ["UNISEX", 33], ["GENTS", 20], ["SPA", 12]],
  2: [["LADIES", 38], ["GENTS", 32], ["UNISEX", 22], ["SPA", 8]],
  3: [["GENTS", 46], ["LADIES", 38], ["UNISEX", 13], ["SPA", 3]],
  4: [["GENTS", 56], ["LADIES", 38], ["UNISEX", 6]],
};

const PRICE_FACTOR: Record<Tier, number> = { 1: 2.2, 2: 1.5, 3: 1, 4: 0.75 };
const DEPOSIT_MINOR: Record<Tier, number> = { 1: 5000, 2: 3000, 3: 3000, 4: 2000 };

type ServiceDef = {
  name: string;
  category: ServiceCategory;
  duration: number;
  /** Taka at a mid-range (tier 3) salon. */
  price: number;
  description: string;
  core?: boolean;
  /** Offered only at this tier or better. */
  minTier?: Tier;
};

const SERVICES: Record<SalonType, ServiceDef[]> = {
  GENTS: [
    { name: "Haircut", category: "HAIRCUT", duration: 30, price: 200, core: true, description: "Consultation, wash and a cut of your choice, finished with styling." },
    { name: "Beard Trim & Shape", category: "HAIRCUT", duration: 20, price: 120, core: true, description: "Trim, line-up and shape, finished with a hot towel." },
    { name: "Haircut & Beard Combo", category: "HAIRCUT", duration: 45, price: 300, description: "A full haircut plus beard trim and shape at a combo price." },
    { name: "Hot Towel Shave", category: "HAIRCUT", duration: 30, price: 150, description: "Classic straight-razor shave with hot towels and a soothing balm." },
    { name: "Kids Haircut", category: "HAIRCUT", duration: 20, price: 150, description: "For boys under 12. Patient barbers, quick and neat." },
    { name: "Hair Colour (Men)", category: "COLORING", duration: 45, price: 500, description: "Ammonia-free colour to cover greys or change your shade." },
    { name: "Beard Colour", category: "COLORING", duration: 30, price: 250, description: "Natural-looking beard colour, patch-tested before it goes on." },
    { name: "Head & Shoulder Massage", category: "MASSAGE", duration: 20, price: 200, description: "Oil massage for the head, neck and shoulders to release tension." },
    { name: "Face Cleanup", category: "FACIAL", duration: 30, price: 400, description: "Deep cleanse, scrub and steam for fresh, clear skin." },
    { name: "Charcoal Facial", category: "FACIAL", duration: 45, price: 800, description: "Detoxifying charcoal facial that lifts oil and blackheads." },
    { name: "Hair Spa (Men)", category: "TREATMENT", duration: 45, price: 700, description: "Nourishing hair spa for dry, frizzy or thinning hair." },
    { name: "Anti-Dandruff Treatment", category: "TREATMENT", duration: 45, price: 600, description: "Scalp cleanse and treatment to bring dandruff under control." },
    { name: "Keratin Smoothing (Men)", category: "TREATMENT", duration: 90, price: 2500, minTier: 2, description: "Smoother, frizz-free hair that lasts up to three months." },
  ],
  LADIES: [
    { name: "Eyebrow Threading", category: "WAXING", duration: 15, price: 60, core: true, description: "Clean, defined brows shaped to suit your face." },
    { name: "Ladies Haircut", category: "HAIRCUT", duration: 45, price: 400, core: true, description: "Consultation, wash, cut and blow-dry. Layers, steps or a simple trim." },
    { name: "Blow Dry & Styling", category: "STYLING", duration: 45, price: 500, description: "Smooth blow-dry, curls or waves for a party or an event." },
    { name: "Hair Spa", category: "TREATMENT", duration: 60, price: 1200, description: "Deep-conditioning spa with steam and massage for soft, shiny hair." },
    { name: "Hair Rebonding", category: "TREATMENT", duration: 180, price: 4000, description: "Permanent straightening for sleek, manageable hair." },
    { name: "Keratin Treatment", category: "TREATMENT", duration: 150, price: 5000, description: "Frizz control and shine that lasts three to four months." },
    { name: "Global Hair Colour", category: "COLORING", duration: 120, price: 2500, description: "All-over colour with a professional, ammonia-free range." },
    { name: "Highlights", category: "COLORING", duration: 120, price: 3500, minTier: 3, description: "Balayage or foil highlights, toned to suit your skin." },
    { name: "Gold Facial", category: "FACIAL", duration: 60, price: 1500, description: "Brightening gold facial for a glow before an event." },
    { name: "Fruit Facial", category: "FACIAL", duration: 60, price: 900, description: "Gentle fruit-extract facial that suits most skin types." },
    { name: "Hydra Facial", category: "FACIAL", duration: 60, price: 3000, minTier: 2, description: "Cleanse, exfoliate and hydrate in one machine-assisted treatment." },
    { name: "Manicure", category: "MANICURE", duration: 45, price: 600, description: "Soak, shape, cuticle care, massage and polish." },
    { name: "Pedicure", category: "PEDICURE", duration: 60, price: 800, description: "Foot soak, scrub, nail care and a relaxing massage." },
    { name: "Full Arms Waxing", category: "WAXING", duration: 30, price: 500, description: "Smooth arms with a gentle, low-irritation wax." },
    { name: "Party Makeup", category: "MAKEUP", duration: 90, price: 2500, description: "Makeup and hairdo for weddings, holud and parties." },
    { name: "Bridal Makeup", category: "MAKEUP", duration: 180, price: 12000, minTier: 3, description: "Full bridal look with hair, draping and a trial on request." },
    { name: "Mehedi Design", category: "OTHER", duration: 60, price: 800, description: "Hand-drawn mehedi for both hands, from simple to bridal." },
  ],
  UNISEX: [
    { name: "Men's Haircut", category: "HAIRCUT", duration: 30, price: 300, core: true, description: "Cut, wash and style by our senior stylists." },
    { name: "Ladies Haircut", category: "HAIRCUT", duration: 45, price: 500, core: true, description: "Consultation, wash, cut and blow-dry." },
    { name: "Beard Trim", category: "HAIRCUT", duration: 20, price: 150, description: "Trim and shape with a hot towel finish." },
    { name: "Hair Colour", category: "COLORING", duration: 90, price: 1800, description: "Global colour or root touch-up with premium colour." },
    { name: "Hair Spa", category: "TREATMENT", duration: 60, price: 1200, description: "Deep-conditioning treatment for soft, healthy hair." },
    { name: "Keratin Treatment", category: "TREATMENT", duration: 150, price: 5000, description: "Frizz-free, glossy hair for up to four months." },
    { name: "Signature Facial", category: "FACIAL", duration: 60, price: 1500, description: "Our house facial: cleanse, exfoliate, mask and massage." },
    { name: "Manicure", category: "MANICURE", duration: 45, price: 700, description: "Nail shaping, cuticle care, massage and polish." },
    { name: "Pedicure", category: "PEDICURE", duration: 60, price: 900, description: "Soak, scrub, nail care and a relaxing foot massage." },
    { name: "Eyebrow Threading", category: "WAXING", duration: 15, price: 80, description: "Neat, defined brows." },
    { name: "Blow Dry", category: "STYLING", duration: 30, price: 500, description: "Smooth, voluminous blow-dry." },
  ],
  SPA: [
    { name: "Swedish Massage", category: "MASSAGE", duration: 60, price: 2500, core: true, description: "Full-body relaxation massage with long, flowing strokes." },
    { name: "Thai Massage", category: "MASSAGE", duration: 90, price: 3000, core: true, description: "Traditional stretching massage on a mat, done fully clothed." },
    { name: "Aromatherapy Massage", category: "SPA", duration: 60, price: 2800, description: "Essential-oil massage chosen to calm or energise." },
    { name: "Hot Stone Massage", category: "MASSAGE", duration: 90, price: 3500, description: "Warm basalt stones melt away deep muscle tension." },
    { name: "Body Scrub & Polish", category: "SPA", duration: 45, price: 2000, description: "Exfoliating scrub followed by a moisturising wrap." },
    { name: "Foot Reflexology", category: "MASSAGE", duration: 45, price: 1500, description: "Pressure-point foot massage for tired feet." },
    { name: "Deep Cleansing Facial", category: "FACIAL", duration: 60, price: 2000, description: "Cleanse, steam, extraction and a calming mask." },
  ],
};

const SERVICE_COUNT: Record<SalonType, readonly [number, number]> = {
  GENTS: [4, 5],
  LADIES: [5, 6],
  UNISEX: [5, 6],
  SPA: [4, 5],
};

type CounterDef = { name: string; code: string; categories: ServiceCategory[] };

const COUNTERS: Record<SalonType, CounterDef[]> = {
  GENTS: [
    { name: "Barber Station", code: "BS-1", categories: ["HAIRCUT", "COLORING", "MASSAGE"] },
    { name: "Grooming Room", code: "GR-1", categories: ["FACIAL", "TREATMENT", "OTHER"] },
  ],
  LADIES: [
    { name: "Hair Station", code: "HS-1", categories: ["HAIRCUT", "STYLING", "COLORING", "TREATMENT"] },
    { name: "Beauty Room", code: "BR-1", categories: ["FACIAL", "WAXING", "MANICURE", "PEDICURE", "OTHER"] },
    { name: "Makeup Studio", code: "MS-1", categories: ["MAKEUP"] },
  ],
  UNISEX: [
    { name: "Hair Floor", code: "HF-1", categories: ["HAIRCUT", "STYLING", "COLORING", "TREATMENT"] },
    { name: "Beauty & Nails", code: "BN-1", categories: ["FACIAL", "WAXING", "MANICURE", "PEDICURE", "MAKEUP", "OTHER"] },
  ],
  SPA: [
    { name: "Therapy Room 1", code: "TR-1", categories: ["MASSAGE"] },
    { name: "Therapy Room 2", code: "TR-2", categories: ["SPA"] },
    { name: "Facial Suite", code: "FS-1", categories: ["FACIAL", "OTHER"] },
  ],
};

type StaffRole = { title: string; categories: ServiceCategory[]; gender: "M" | "F" | "ANY" };

const STAFF_ROLES: Record<SalonType, StaffRole[]> = {
  GENTS: [
    { title: "Senior Barber", categories: ["HAIRCUT", "COLORING", "MASSAGE"], gender: "M" },
    { title: "Barber", categories: ["HAIRCUT", "MASSAGE"], gender: "M" },
    { title: "Grooming Specialist", categories: ["FACIAL", "TREATMENT", "COLORING"], gender: "M" },
  ],
  LADIES: [
    { title: "Senior Hair Stylist", categories: ["HAIRCUT", "STYLING", "COLORING", "TREATMENT"], gender: "F" },
    { title: "Beautician", categories: ["FACIAL", "WAXING", "MANICURE", "PEDICURE", "OTHER"], gender: "F" },
    { title: "Makeup Artist", categories: ["MAKEUP", "STYLING", "OTHER"], gender: "F" },
  ],
  UNISEX: [
    { title: "Hair Stylist", categories: ["HAIRCUT", "STYLING", "COLORING", "TREATMENT"], gender: "ANY" },
    { title: "Barber", categories: ["HAIRCUT"], gender: "M" },
    { title: "Beauty Therapist", categories: ["FACIAL", "WAXING", "MANICURE", "PEDICURE", "MAKEUP"], gender: "F" },
  ],
  SPA: [
    { title: "Senior Therapist", categories: ["MASSAGE", "SPA", "FACIAL"], gender: "F" },
    { title: "Massage Therapist", categories: ["MASSAGE", "SPA"], gender: "ANY" },
    { title: "Skin Therapist", categories: ["FACIAL", "SPA"], gender: "F" },
  ],
};

const MALE_FIRST = ["Rafiq", "Jamal", "Shahin", "Sumon", "Rubel", "Kamal", "Babul", "Mizan", "Faruk", "Alamgir", "Hasan", "Rasel", "Jewel", "Liton", "Sujon", "Shipon", "Mamun", "Arif", "Sabbir", "Shakil", "Rakib", "Imran", "Masud", "Rana", "Nayeem", "Tanvir", "Fahim", "Sakib", "Tamim", "Mehedi", "Rifat", "Nahid", "Asif", "Shohel", "Rony", "Jahid", "Anik", "Tuhin", "Emon", "Saiful", "Monir", "Habib", "Delwar", "Kawsar", "Zahid", "Riyad", "Tareq", "Mahfuz", "Ashik", "Shamim"];
const MALE_LAST = ["Hossain", "Rahman", "Islam", "Ahmed", "Uddin", "Mia", "Khan", "Chowdhury", "Sarker", "Mollah", "Sheikh", "Talukder", "Bhuiyan", "Hawlader", "Akand", "Mridha", "Biswas", "Das", "Roy", "Kabir"];
// Barbering is a family trade in Bangladesh; many barbers carry the Shil name.
const BARBER_NAMES = ["Nitai Chandra Shil", "Gopal Shil", "Sujit Shil", "Ratan Shil", "Shyamal Chandra Shil", "Dilip Shil", "Nirmal Shil", "Uttam Shil", "Sanjoy Shil", "Bablu Shil", "Pradip Shil", "Haradhan Shil"];
const FEMALE_FIRST = ["Nusrat", "Farhana", "Sadia", "Tania", "Shathi", "Rupa", "Mitu", "Tanjila", "Sumaiya", "Tasnim", "Anika", "Shirin", "Lima", "Poly", "Mim", "Riya", "Jui", "Sabrina", "Rumana", "Nasrin", "Sharmin", "Dilruba", "Munni", "Shampa", "Keya", "Joya", "Mousumi", "Rehana", "Parvin", "Shammi", "Lipi", "Sonia", "Rina", "Shilpi", "Nabila", "Fatema", "Ayesha", "Maliha", "Tahmina", "Rokeya", "Jannatul", "Afsana", "Israt", "Moriom", "Sanjida", "Shanta", "Priya", "Lubna"];
const FEMALE_LAST = ["Akter", "Begum", "Khatun", "Islam", "Rahman", "Jahan", "Sultana", "Chowdhury", "Hossain", "Ahmed", "Nahar", "Yasmin", "Haque", "Das", "Roy", "Ferdous"];

type NameMaker = (r: Rng) => string;

const GENTS_WORDS = ["Royal", "Smart", "Classic", "Modern", "New Style", "Friends", "Star", "Prince", "Nobab", "Shaheb", "Dream", "Ideal", "Rupali", "Sunrise", "Moonlight", "Diamond", "Rajdhani", "Model", "Trendy", "Sonar Bangla", "Titan", "Metro", "Crown", "Alpha", "Unique", "Stylish", "Cool Cut", "Gentleman", "Handsome", "Bhai Bhai", "Janata", "Probashi", "Blue Bird", "Golden", "Silver Line"];
const GENTS_PREMIUM_WORDS = ["Dapper", "Groomed", "Bearded", "Sharp", "Urban", "Heritage", "Ironside", "Fade Room", "Oak & Blade", "Clipper House", "The Gentry", "Straight Edge"];
const LADIES_BANGLA = ["Rupkotha", "Oporupa", "Nakshi", "Chandni", "Moyuri", "Shapla", "Shiuli", "Bokul", "Kamini", "Jonaki", "Meghla", "Aparajita", "Tilottoma", "Priyonti", "Labonno", "Rongdhonu", "Nilanjona", "Madhobi", "Hasnahena", "Rajkonna", "Anjana", "Nupur", "Jhumka", "Kajol", "Rojonigondha", "Sonali", "Chandrima", "Oishee", "Sanjhbati", "Shimul", "Chhayanika", "Nokkhotro"];
const LADIES_ENGLISH = ["Lavender", "Orchid", "Lily", "Tulip", "Blossom", "Pearl", "Ruby", "Jasmine", "Magnolia", "Rose Petal", "Butterfly", "Angel", "Queen's", "Princess", "Pink", "Glamour", "Diva", "Grace", "Charm", "Venus", "Bella", "Elegance", "Sapphire", "Emerald", "Crystal"];
const UNISEX_WORDS = ["Glow", "Luxe", "Aura", "Radiance", "Allure", "Velvet", "Silk", "Ivory", "Amber", "Mirage", "Opal", "Bliss", "Halo", "Hairology", "Style Station", "Trendsetters", "Headlines", "Scissors & Co.", "Cut & Colour", "Snip", "Strands", "Tresses", "Studio 9", "Studio 27", "Mirror Mirror", "Kesh Kalpa"];
const SPA_WORDS = ["Serenity", "Tranquil", "Bamboo", "Siam", "Thai Touch", "Nirvana", "Zen Garden", "Blue Lagoon", "Aroma", "Oasis", "Calm", "Harmony", "Sandalwood", "Lemongrass", "Tamarind", "Frangipani"];

const NAME_MAKERS: Record<SalonType, (tier: Tier) => NameMaker[]> = {
  GENTS: (tier) => [
    (r) => `${pick(r, GENTS_WORDS)} Gents Parlour`,
    (r) => `${pick(r, GENTS_WORDS)} Hair Cutting Salon`,
    (r) => `${pick(r, GENTS_WORDS)} Men's Salon`,
    (r) => `${pick(r, GENTS_WORDS)} Barber Shop`,
    (r) => `${pick(r, MALE_FIRST)}'s Hair Studio`,
    ...(tier <= 2
      ? [
          (r: Rng) => `${pick(r, GENTS_PREMIUM_WORDS)} Barbers`,
          (r: Rng) => `${pick(r, GENTS_PREMIUM_WORDS)} Men's Grooming Lounge`,
          (r: Rng) => `The ${pick(r, GENTS_PREMIUM_WORDS)} Barber Co.`,
        ]
      : []),
  ],
  LADIES: () => [
    (r) => `${pick(r, LADIES_BANGLA)} Beauty Parlour`,
    (r) => `${pick(r, LADIES_BANGLA)} Ladies Parlour`,
    (r) => `${pick(r, LADIES_ENGLISH)} Beauty Salon`,
    (r) => `${pick(r, LADIES_ENGLISH)} Ladies Parlour`,
    (r) => `${pick(r, LADIES_BANGLA)} Bridal Studio`,
    (r) => `${pick(r, LADIES_ENGLISH)} Makeover Studio`,
    (r) => `${pick(r, LADIES_ENGLISH)} Beauty Lounge`,
    (r) => `${pick(r, FEMALE_FIRST)}'s Beauty Parlour`,
  ],
  UNISEX: () => [
    (r) => `${pick(r, UNISEX_WORDS)} Salon & Spa`,
    (r) => `${pick(r, UNISEX_WORDS)} Hair Studio`,
    (r) => `${pick(r, UNISEX_WORDS)} Unisex Salon`,
    (r) => `${pick(r, UNISEX_WORDS)} Hair & Beauty`,
  ],
  SPA: () => [
    (r) => `${pick(r, SPA_WORDS)} Spa & Wellness`,
    (r) => `${pick(r, SPA_WORDS)} Thai Spa`,
    (r) => `${pick(r, SPA_WORDS)} Day Spa`,
    (r) => `${pick(r, SPA_WORDS)} Massage & Spa`,
  ],
};

/** Fictional chains; about one salon in six is a branch of one. */
const CHAINS: { name: string; type: SalonType; tiers: Tier[] }[] = [
  { name: "Rupkotha Beauty Parlour", type: "LADIES", tiers: [2, 3, 4] },
  { name: "Nakshi Beauty Lounge", type: "LADIES", tiers: [1, 2, 3] },
  { name: "Moyuri Ladies Parlour", type: "LADIES", tiers: [3, 4] },
  { name: "Sharp Blade Barber Shop", type: "GENTS", tiers: [2, 3, 4] },
  { name: "Nobab Gents Parlour", type: "GENTS", tiers: [3, 4] },
  { name: "Fade Street Barbers", type: "GENTS", tiers: [1, 2] },
  { name: "Mane Street Salon & Spa", type: "UNISEX", tiers: [1, 2] },
  { name: "Glow Up Unisex Salon", type: "UNISEX", tiers: [2, 3] },
  { name: "Lotus Thai Spa", type: "SPA", tiers: [1, 2] },
];

const unsplash = (id: string) =>
  `https://images.unsplash.com/photo-${id}?w=1200&h=800&fit=crop&auto=format&q=75`;

// Every id below was checked to load and to show what its pool says.
const IMAGES: Record<SalonType, string[]> = {
  GENTS: ["1585747860715-2ba37e788b70", "1503951914875-452162b0f3f1", "1599351431202-1e0f0137899a", "1621605815971-fbc98d665033", "1605497788044-5a32c7078486", "1622286342621-4bd786c2447c", "1517832606299-7ae9b720a186", "1532710093739-9470acff878f", "1560066984-138dadb4c035", "1600948836101-f9ffda59d250"].map(unsplash),
  LADIES: ["1521590832167-7bcbfaa6381f", "1562322140-8baeececf3df", "1522337360788-8b13dee7a37e", "1580618672591-eb180b1a973f", "1595476108010-b4d1f102b1b1", "1487412947147-5cebf100ffc2", "1570172619644-dfd03ed5d881", "1604654894610-df63bc536371", "1519014816548-bf5fe059798b", "1516975080664-ed2fc6a32937", "1634449571010-02389ed0f9b0", "1582095133179-bfd08e2fc6b3", "1629397685944-7073f5589754", "1519415387722-a1c3bbef716c", "1596704017254-9b121068fb31"].map(unsplash),
  UNISEX: ["1633681926022-84c23e8cb2d6", "1560066984-138dadb4c035", "1600948836101-f9ffda59d250", "1633681926035-ec1ac984418a", "1559599101-f09722fb4948", "1562322140-8baeececf3df", "1527799820374-dcf8d9d4a388", "1622286342621-4bd786c2447c", "1595476108010-b4d1f102b1b1"].map(unsplash),
  SPA: ["1540555700478-4be289fbecef", "1544161515-4ab6ce6db874", "1596178060671-7a80dc8059ea", "1560750588-73207b1ef5b8", "1600334129128-685c5582fd35", "1515377905703-c4788e51af15", "1591343395082-e120087004b4", "1507652313519-d4e9174996dd", "1583416750470-965b2707b355", "1552693673-1bf958298935"].map(unsplash),
};

const SERVICE_IMAGES: Record<ServiceCategory, string[]> = {
  HAIRCUT: ["1622286342621-4bd786c2447c", "1599351431202-1e0f0137899a", "1562322140-8baeececf3df"].map(unsplash),
  STYLING: ["1629397685944-7073f5589754", "1580618672591-eb180b1a973f", "1582095133179-bfd08e2fc6b3"].map(unsplash),
  COLORING: ["1522337360788-8b13dee7a37e", "1527799820374-dcf8d9d4a388"].map(unsplash),
  TREATMENT: ["1595476108010-b4d1f102b1b1", "1634449571010-02389ed0f9b0"].map(unsplash),
  SPA: ["1540555700478-4be289fbecef", "1507652313519-d4e9174996dd"].map(unsplash),
  FACIAL: ["1570172619644-dfd03ed5d881", "1616394584738-fc6e612e71b9", "1552693673-1bf958298935"].map(unsplash),
  MANICURE: ["1604654894610-df63bc536371", "1519014816548-bf5fe059798b"].map(unsplash),
  PEDICURE: ["1519014816548-bf5fe059798b", "1604654894610-df63bc536371"].map(unsplash),
  MAKEUP: ["1487412947147-5cebf100ffc2", "1516975080664-ed2fc6a32937", "1596704017254-9b121068fb31"].map(unsplash),
  WAXING: ["1519415387722-a1c3bbef716c"].map(unsplash),
  MASSAGE: ["1544161515-4ab6ce6db874", "1600334129128-685c5582fd35", "1591343395082-e120087004b4"].map(unsplash),
  OTHER: ["1487412947147-5cebf100ffc2"].map(unsplash),
};

const BUILDINGS = ["Rahman Tower", "Karim Plaza", "Nurjahan Heights", "Anam Mansion", "Rupayan Centre", "Shaheen Plaza", "Haque Tower", "Bashir Market", "Golden Plaza", "City Centre", "Noor Complex", "Madina Market", "Al-Amin Tower", "Tahera Mansion", "Karnaphuli Plaza", "Ittefaq Bhaban", "Khan Plaza", "Mollah Complex", "Rose View Plaza", "Sheltech Centre"];

const REVIEWS: Record<1 | 2 | 3 | 4 | 5, string[]> = {
  5: [
    "Best {service} I've had in Dhaka. {staff} really knows the job.",
    "Very clean and well organised. My slot started right on time.",
    "{staff} is skilled and friendly. Will definitely come back.",
    "Excellent service and a fair price for {locality}.",
    "Khub valo service, staff ra onek friendly. Highly recommended!",
    "Booked online and was seated at exactly my time. Loved it.",
    "Very hygienic - fresh towels, and they sanitised the tools in front of me.",
    "My go-to place now. The {service} was perfect.",
    "Onek sundor kaj, dam o thik ache.",
    "Great ambience and the AC actually works. Top class {service}.",
    "Came for a {service} before a wedding and got so many compliments.",
    "Polite staff, no rush, and they listened to exactly what I wanted.",
  ],
  4: [
    "Good {service}, a bit crowded on Friday evening.",
    "Nice work by {staff}. Waited about ten minutes but it was worth it.",
    "Quality is good, price is slightly on the higher side.",
    "Valo legeche, next time abar ashbo.",
    "Clean place and polite staff. Parking is difficult, though.",
    "Solid {service}. Would be five stars if they were on time.",
    "Good experience overall. The waiting area could be bigger.",
  ],
  3: [
    "Average experience. The {service} was okay, nothing special.",
    "Had to wait 25 minutes even with a booking.",
    "Decent, but the place was too busy and a bit noisy.",
    "Kaj thik ache, kintu onek khon opekkha korte hoyeche.",
    "{service} was fine, but the finishing could be better.",
  ],
  2: [
    "Not happy with the {service}; had to get it fixed elsewhere.",
    "They were late and rushed the job.",
    "Too expensive for what you get.",
  ],
  1: [
    "Very disappointing. My booked slot was not honoured.",
    "Rude behaviour at the counter. Won't come back.",
  ],
};

const CANCEL_REASONS = ["Change of plans", "Could not make it because of traffic", "Booked the wrong date", "Feeling unwell", "Rescheduled to another day"];
const BOOKING_NOTES = ["First time here.", "Please keep it short on the sides.", "Need to finish before 6 pm.", "Bridal trial, please allow extra time.", "Sensitive skin - please use mild products.", "Coming with a friend.", "Prefer the same stylist as last time."];

// ---------------------------------------------------------------------------
// Plan: everything is built in memory first, so a dry run can show it.

type SalonPlan = {
  id: string;
  index: number;
  loc: Location;
  type: SalonType;
  tier: Tier;
  name: string;
  quality: number;
  popularity: number;
  hours: Record<(typeof WEEKDAYS)[number], { open: string; close: string }>;
  row: Prisma.SalonCreateManyInput;
  counters: (Prisma.CounterCreateManyInput & { id: string; def: CounterDef })[];
  services: (Prisma.ServiceCreateManyInput & { id: string; counterId: string; days: number[] })[];
  staff: { id: string; userId: string; categories: ServiceCategory[]; fullName: string; title: string }[];
};

type Person = { id: string; name: string; gender: Gender };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");

const roundPrice = (taka: number) =>
  taka < 500 ? Math.round(taka / 10) * 10 : taka < 2000 ? Math.round(taka / 50) * 50 : Math.round(taka / 100) * 100;

/**
 * Online-bookable starts: one every `step` minutes, ending before close. Real
 * salons keep most chairs for walk-ins, and the spacing is also what keeps
 * ~590 salons x 30 days inside the database's storage cap (~390 bytes a slot).
 */
const slotStep = (duration: number) =>
  duration <= 60 ? 120 : duration <= 90 ? 150 : duration <= 120 ? 180 : 240;

const startsFor = (open: string, close: string, duration: number) => {
  const out: number[] = [];
  const end = toMinute(close);
  for (let m = toMinute(open); m + duration <= end; m += slotStep(duration)) out.push(m);
  return out;
};

const shortLocality = (locality: string) => {
  const uttara = /^Sector (\d+), Uttara$/.exec(locality);
  if (uttara) return `Uttara ${uttara[1]}`;
  if (locality.includes("Bashundhara")) return "Bashundhara";
  return locality.split(",")[0];
};

const phoneFor = (r: Rng, used: Set<string>) => {
  for (;;) {
    const phone = `01${pick(r, ["3", "4", "5", "6", "7", "8", "9"])}${String(int(r, 0, 99999999)).padStart(8, "0")}`;
    if (!used.has(phone)) {
      used.add(phone);
      return phone;
    }
  }
};

const addressFor = (r: Rng, loc: Location) => {
  const place = `${loc.locality}, Dhaka ${loc.zip}`;
  if (!loc.road) return `House ${int(r, 3, 120)}, ${place}`;
  if (loc.mainRoad && chance(r, 0.7)) {
    const shop = `Shop ${int(r, 1, 48)}, ${pick(r, ["Ground Floor", "Level 1", "Level 2", "1st Floor", "2nd Floor"])}`;
    return `${shop}, ${pick(r, BUILDINGS)}, ${loc.road}, ${place}`;
  }
  return `House ${int(r, 1, 98)}${chance(r, 0.15) ? pick(r, ["/A", "/B", "/1"]) : ""}, ${loc.road}, ${place}`;
};

const hoursFor = (r: Rng, type: SalonType) => {
  const [open, close, fridayLate]: [string, string, boolean] =
    type === "GENTS"
      ? [weighted(r, [["09:00", 2], ["10:00", 6], ["11:00", 2]] as const), pick(r, ["21:00", "21:30", "22:00"]), chance(r, 0.5)]
      : type === "LADIES"
        ? [pick(r, ["10:00", "10:30", "11:00"]), pick(r, ["19:30", "20:00", "20:30"]), chance(r, 0.4)]
        : type === "UNISEX"
          ? [pick(r, ["10:00", "11:00"]), pick(r, ["20:00", "21:00"]), chance(r, 0.3)]
          : [pick(r, ["11:00", "12:00"]), pick(r, ["21:00", "22:00"]), false];
  const hours = {} as SalonPlan["hours"];
  for (const day of WEEKDAYS) {
    hours[day] = { open: day === "friday" && fridayLate ? "15:00" : open, close };
  }
  return { hours, fridayLate };
};

const describe = (r: Rng, s: { name: string; type: SalonType; tier: Tier; loc: Location; services: string[]; fridayLate: boolean; since: number }) => {
  const where = s.loc.road ? `${s.loc.road}, ${s.loc.locality}` : s.loc.locality;
  const [a, b] = shuffle(r, s.services).map((x) => x.toLowerCase());
  const opener = {
    GENTS: [
      `${s.name} is a neighbourhood gents' salon on ${where}.`,
      `A friendly barber shop in ${s.loc.locality}, cutting hair here since ${s.since}.`,
      s.tier <= 2
        ? `A modern men's grooming lounge in ${s.loc.locality} with a relaxed, air-conditioned space.`
        : `Walk-in style barber shop on ${where}, now taking online bookings.`,
    ],
    LADIES: [
      `A ladies-only beauty parlour in ${s.loc.locality}, run by an all-female team.`,
      `${s.name} has looked after the women of ${s.loc.locality} since ${s.since}.`,
      `A cosy beauty parlour on ${where} with private rooms for facials and waxing.`,
    ],
    UNISEX: [
      `A unisex salon in ${s.loc.locality} with separate men's and ladies' sections.`,
      `${s.name} is a full-service hair and beauty studio on ${where}.`,
    ],
    SPA: [
      `A calm day spa in ${s.loc.locality} for massage, body treatments and facials.`,
      `${s.name} brings traditional Thai and Swedish therapies to ${s.loc.locality}.`,
    ],
  }[s.type];
  const extras = [
    "Fully air-conditioned.",
    "Card and bKash payments accepted.",
    "Walk-ins welcome, but booking saves you the wait.",
    "Generator backup, so no waiting during load-shedding.",
    ...(s.type === "LADIES" ? ["Female staff only.", "Home service available for bridal bookings."] : []),
    ...(s.type === "GENTS" ? ["Tea while you wait.", "Kids welcome."] : []),
    ...(s.tier <= 2 ? ["Parking available in the building."] : []),
    ...(s.fridayLate ? ["Opens after Jumu'ah prayer on Fridays."] : []),
  ];
  return [
    pick(r, opener),
    `Popular for ${a}${b ? ` and ${b}` : ""}.`,
    ...shuffle(r, extras).slice(0, int(r, 1, 2)),
  ].join(" ");
};

type Plan = {
  owner: { userId: string; salonOwnerId: string };
  customers: (Person & Prisma.UserCreateManyInput)[];
  staffUsers: Prisma.UserCreateManyInput[];
  salons: SalonPlan[];
  probes: [number, number][];
};

const buildPlan = (locations: Location[], probes: [number, number][], owner: Plan["owner"]): Plan => {
  const phones = new Set<string>();
  const emails = new Set<string>();
  const uniqueEmail = (base: string) => {
    let n = 1;
    let email = `${base}@${SEED_EMAIL_DOMAIN}`;
    while (emails.has(email)) email = `${base}.${++n}@${SEED_EMAIL_DOMAIN}`;
    emails.add(email);
    return email;
  };
  const verifiedAt = new Date(nowMs - 200 * DAY_MS);

  const cr = rngFor("customers");
  const customers: Plan["customers"] = Array.from({ length: CUSTOMER_COUNT }, (_, i) => {
    const female = i % 2 === 1;
    const name = female
      ? `${pick(cr, FEMALE_FIRST)} ${pick(cr, FEMALE_LAST)}`
      : `${pick(cr, MALE_FIRST)} ${pick(cr, MALE_LAST)}`;
    const id = randomUUID();
    return {
      id,
      name,
      gender: female ? Gender.FEMALE : Gender.MALE,
      email: uniqueEmail(slug(name)),
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      phone: phoneFor(cr, phones),
      emailVerified: true,
      emailVerifiedAt: verifiedAt,
      createdAt: new Date(nowMs - int(cr, 130, 500) * DAY_MS),
    };
  });

  const usedNames = new Set<string>();
  const staffUsers: Prisma.UserCreateManyInput[] = [];
  const salons: SalonPlan[] = [];

  locations.forEach((loc, index) => {
    const r = rngFor(`salon:${index}`);
    const tier = Math.min(4, Math.max(1, loc.tier + weighted(r, [[0, 85], [-1, 10], [1, 5]] as const))) as Tier;

    // Name and type: a chain branch now and then, otherwise a local name.
    const chains = CHAINS.filter((c) => c.tiers.includes(tier));
    const chain = chance(r, 0.17) && chains.length ? pick(r, chains) : null;
    const type: SalonType = chain ? chain.type : weighted(r, TYPE_MIX[tier]);
    let name = chain ? `${chain.name} (${shortLocality(loc.locality)})` : pick(r, NAME_MAKERS[type](tier))(r);
    for (let attempt = 0; usedNames.has(name.toLowerCase()) && attempt < 8; attempt++) {
      name = pick(r, NAME_MAKERS[type](tier))(r);
    }
    if (usedNames.has(name.toLowerCase())) name = `${name} (${shortLocality(loc.locality)})`;
    usedNames.add(name.toLowerCase());

    const salonId = randomUUID();
    const { hours, fridayLate } = hoursFor(r, type);
    const since = int(r, 2006, 2023);
    const quality = Math.min(4.95, Math.max(2.9, 4.35 + gauss(r) * 0.3));
    const popularity = Math.min(1.6, Math.max(0.5, 1 + gauss(r) * 0.3 + (tier <= 2 ? 0.1 : 0)));

    // Menu: the core services plus a few more this tier can offer.
    const menu = SERVICES[type].filter((s) => !s.minTier || tier <= s.minTier);
    const [minCount, maxCount] = SERVICE_COUNT[type];
    const count = int(r, minCount, maxCount);
    const chosen = [...menu.filter((s) => s.core), ...shuffle(r, menu.filter((s) => !s.core))].slice(0, count);

    const counters: SalonPlan["counters"] = [];
    const counterFor = (category: ServiceCategory) => {
      const def = COUNTERS[type].find((c) => c.categories.includes(category)) ?? COUNTERS[type][0];
      let counter = counters.find((c) => c.def === def);
      if (!counter) {
        counter = { id: randomUUID(), salonId, name: def.name, code: def.code, def, isActive: true };
        counters.push(counter);
      }
      return counter.id;
    };

    const services: SalonPlan["services"] = chosen.map((def) => {
      const priceTaka = roundPrice(def.price * PRICE_FACTOR[tier] * (0.88 + r() * 0.24));
      // Long, specialist services are not on every day of the week.
      const days = !def.core && def.duration >= 90 && chance(r, 0.5)
        ? shuffle(r, [0, 1, 2, 3, 4, 5, 6]).slice(0, int(r, 3, 5)).sort()
        : [0, 1, 2, 3, 4, 5, 6];
      return {
        id: randomUUID(),
        salonId,
        name: def.name,
        description: def.description,
        category: def.category,
        priceMinor: priceTaka * 100,
        duration: def.duration,
        images: [pick(r, SERVICE_IMAGES[def.category])],
        isActive: true,
        counterId: counterFor(def.category),
        days,
      };
    });

    // Staff: enough people that every service has someone who does it.
    const roles = STAFF_ROLES[type];
    const staffCount = int(r, tier <= 2 ? 3 : 2, tier <= 2 ? 5 : 4);
    const staff: SalonPlan["staff"] = [];
    for (let i = 0; i < staffCount; i++) {
      const role = i < roles.length ? roles[i] : pick(r, roles);
      const female = role.gender === "F" || (role.gender === "ANY" && chance(r, 0.5));
      const fullName = female
        ? `${pick(r, FEMALE_FIRST)} ${pick(r, FEMALE_LAST)}`
        : type === "GENTS" && chance(r, 0.3)
          ? pick(r, BARBER_NAMES)
          : `${pick(r, MALE_FIRST)} ${pick(r, MALE_LAST)}`;
      const userId = randomUUID();
      staffUsers.push({
        id: userId,
        name: fullName,
        email: uniqueEmail(slug(fullName)),
        role: UserRole.STAFF,
        status: UserStatus.ACTIVE,
        gender: female ? Gender.FEMALE : Gender.MALE,
        phone: phoneFor(r, phones),
        emailVerified: true,
        emailVerifiedAt: verifiedAt,
      });
      staff.push({ id: randomUUID(), userId, categories: role.categories, fullName, title: role.title });
    }
    for (const service of services) {
      if (!staff.some((s) => s.categories.includes(service.category))) {
        staff[0].categories = [...staff[0].categories, service.category];
      }
    }

    const images = [pick(r, IMAGES[type]), ...shuffle(r, IMAGES[type])]
      .filter((img, i, all) => all.indexOf(img) === i)
      .slice(0, int(r, 3, 4));

    const row: Prisma.SalonCreateManyInput = {
      id: salonId,
      name,
      description: describe(r, { name, type, tier, loc, services: services.map((s) => s.name), fridayLate, since }),
      address: addressFor(r, loc),
      area: loc.area,
      district: "Dhaka",
      division: "Dhaka",
      city: "Dhaka",
      zipCode: loc.zip,
      latitude: loc.lat,
      longitude: loc.lng,
      locationAccuracy: "EXACT",
      locationUpdatedAt: new Date(nowMs - int(r, 5, 60) * DAY_MS),
      phone: phoneFor(r, phones),
      email: chance(r, 0.6) ? `${slug(name).slice(0, 40)}@example.com` : null,
      images,
      operatingHours: hours,
      status: "ACTIVE",
      ownerId: owner.salonOwnerId,
      depositMinor: DEPOSIT_MINOR[tier],
      cancellationWindowMin: weighted(r, [[120, 7], [180, 2], [60, 1]] as const),
      createdAt: new Date(nowMs - int(r, 150, 900) * DAY_MS),
    };

    salons.push({ id: salonId, index, loc, type, tier, name, quality, popularity, hours, row, counters, services, staff });
  });

  return { owner, customers, staffUsers, salons, probes };
};

// ---------------------------------------------------------------------------
// Bookings: history (completed, cancelled, no-show, with reviews) and upcoming
// slots already taken.

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeTokenFactory = (taken: Set<string>) => (r: Rng) => {
  for (;;) {
    let body = "";
    for (let i = 0; i < 5; i++) body += TOKEN_ALPHABET[Math.floor(r() * TOKEN_ALPHABET.length)];
    const token = `TKN-${body}`;
    if (!taken.has(token)) {
      taken.add(token);
      return token;
    }
  }
};

const customersFor = (plan: Plan, type: SalonType) =>
  type === "GENTS"
    ? plan.customers.filter((c) => c.gender === Gender.MALE)
    : type === "LADIES"
      ? plan.customers.filter((c) => c.gender === Gender.FEMALE)
      : plan.customers;

const staffFor = (salon: SalonPlan, category: ServiceCategory) =>
  salon.staff.filter((s) => s.categories.includes(category));

type History = {
  appointments: Prisma.AppointmentCreateManyInput[];
  payments: Prisma.PaymentCreateManyInput[];
  reviews: Prisma.ReviewCreateManyInput[];
};

const buildHistory = (plan: Plan, token: (r: Rng) => string): History => {
  const out: History = { appointments: [], payments: [], reviews: [] };

  for (const salon of plan.salons) {
    const r = rngFor(`history:${salon.index}`);
    const pool = customersFor(plan, salon.type);
    const completed = Math.round(int(r, 12, 24) * salon.popularity);
    const cancelled = int(r, 0, 3);
    const noShow = chance(r, 0.4) ? 1 : 0;

    const visits: AppointmentStatus[] = [
      ...Array<AppointmentStatus>(completed).fill(AppointmentStatus.COMPLETED),
      ...Array<AppointmentStatus>(cancelled).fill(AppointmentStatus.CANCELLED),
      ...Array<AppointmentStatus>(noShow).fill(AppointmentStatus.NO_SHOW),
    ];

    for (const status of visits) {
      const service = pick(r, salon.services);
      const offset = -int(r, 1, HISTORY_DAYS);
      const dayMs = TODAY + offset * DAY_MS;
      const weekday = WEEKDAYS[new Date(dayMs).getUTCDay()];
      const starts = startsFor(salon.hours[weekday].open, salon.hours[weekday].close, service.duration);
      if (!starts.length) continue;
      const start = pick(r, starts);
      const customer = pick(r, pool);
      const staffPool = staffFor(salon, service.category);
      const staff = staffPool.length && chance(r, 0.85) ? pick(r, staffPool) : null;
      const startsAt = dhakaInstant(dayMs, start);
      const createdAt = new Date(startsAt.getTime() - int(r, 2, 240) * 60 * 60 * 1000);
      const id = randomUUID();
      const done = status === AppointmentStatus.COMPLETED;
      const completedAt = new Date(startsAt.getTime() + (service.duration + int(r, 0, 15)) * 60 * 1000);

      out.appointments.push({
        id,
        customerId: customer.id,
        salonId: salon.id,
        serviceId: service.id,
        staffId: staff?.id ?? null,
        counterId: service.counterId,
        appointmentDate: new Date(dayMs),
        startTime: hhmm(start),
        endTime: hhmm(start + service.duration),
        status,
        notes: chance(r, 0.12) ? pick(r, BOOKING_NOTES) : null,
        cancellationReason: status === AppointmentStatus.CANCELLED ? pick(r, CANCEL_REASONS) : null,
        token: token(r),
        serialNumber: starts.indexOf(start) + 1,
        totalMinor: service.priceMinor,
        depositMinor: 0,
        depositStatus: DepositStatus.NONE,
        source: chance(r, 0.8) ? AppointmentSource.PLATFORM : AppointmentSource.SALON_DIRECT,
        bookedVia: weighted(r, [[BookingChannel.WEB, 75], [BookingChannel.ASSISTANT, 10], [BookingChannel.WALK_IN, 15]] as const),
        noShowMarkedAt: status === AppointmentStatus.NO_SHOW ? new Date(startsAt.getTime() + 30 * 60 * 1000) : null,
        checkedInAt: done ? new Date(startsAt.getTime() + int(r, -5, 10) * 60 * 1000) : null,
        completedAt: done ? completedAt : null,
        reminder24At: new Date(startsAt.getTime() - DAY_MS),
        reminder2hAt: new Date(startsAt.getTime() - 2 * 60 * 60 * 1000),
        reviewAskedAt: done ? completedAt : null,
        createdAt: createdAt.getTime() < startsAt.getTime() ? createdAt : startsAt,
        updatedAt: done ? completedAt : startsAt,
      });

      if (!done) continue;

      const method = weighted(r, [[PaymentMethod.CASH, 55], [PaymentMethod.MOBILE_BANKING, 35], [PaymentMethod.CARD, 10]] as const);
      out.payments.push({
        appointmentId: id,
        amountMinor: service.priceMinor,
        paymentMethod: method,
        status: PaymentStatus.COMPLETED,
        transactionId: method === PaymentMethod.CASH ? null : `${method === PaymentMethod.CARD ? "CRD" : "BKS"}${int(r, 10000000, 99999999)}`,
        paymentDate: completedAt,
        createdAt: completedAt,
      });

      if (!chance(r, 0.62)) continue;
      const rating = Math.min(5, Math.max(1, Math.round(salon.quality + gauss(r) * 0.75))) as 1 | 2 | 3 | 4 | 5;
      const staffName = staff ? staff.fullName.split(" ")[0] : "the stylist";
      const comment = chance(r, 0.88)
        ? pick(r, REVIEWS[rating])
            .replace("{service}", service.name.toLowerCase())
            .replace("{staff}", staffName)
            .replace("{locality}", shortLocality(salon.loc.locality))
        : null;
      out.reviews.push({
        appointmentId: id,
        customerId: customer.id,
        salonId: salon.id,
        staffId: staff?.id ?? null,
        rating,
        comment: comment ? comment[0].toUpperCase() + comment.slice(1) : null,
        createdAt: new Date(completedAt.getTime() + int(r, 1, 72) * 60 * 60 * 1000),
      });
    }
  }
  return out;
};

type BookedKey = { salonId: string; serviceId: string; day: string; startTime: string; customerId: string; staffId: string | null; bookedVia: BookingChannel; notes: string | null; createdAt: Date };

/** Which upcoming slots are already taken: weekends and evenings fill first. */
const buildBookedKeys = (plan: Plan) => {
  const keys: BookedKey[] = [];
  let totalSlots = 0;
  for (const salon of plan.salons) {
    const r = rngFor(`booked:${salon.index}`);
    const pool = customersFor(plan, salon.type);
    for (const service of salon.services) {
      for (let offset = 0; offset < SLOT_DAYS; offset++) {
        const dayMs = TODAY + offset * DAY_MS;
        const dow = new Date(dayMs).getUTCDay();
        if (!service.days.includes(dow)) continue;
        const hours = salon.hours[WEEKDAYS[dow]];
        for (const start of startsFor(hours.open, hours.close, service.duration)) {
          totalSlots++;
          if (offset === 0 && start <= NOW_MINUTE + 30) continue;
          const weekend = dow === 5 ? 1.7 : dow === 6 ? 1.4 : 1;
          const evening = start >= 17 * 60 ? 1.5 : start >= 12 * 60 ? 1 : 0.6;
          const soon = offset <= 3 ? 1.9 : offset <= 10 ? 1.1 : 0.55;
          if (!chance(r, 0.034 * weekend * evening * soon * salon.popularity)) continue;
          const staffPool = staffFor(salon, service.category);
          const startsAt = dhakaInstant(dayMs, start);
          const bookedAgo = int(r, 1, Math.max(2, offset * 24 + 20)) * 60 * 60 * 1000;
          keys.push({
            salonId: salon.id,
            serviceId: service.id,
            day: isoDay(offset),
            startTime: hhmm(start),
            customerId: pick(r, pool).id,
            staffId: staffPool.length && chance(r, 0.7) ? pick(r, staffPool).id : null,
            bookedVia: chance(r, 0.12) ? BookingChannel.ASSISTANT : BookingChannel.WEB,
            notes: chance(r, 0.1) ? pick(r, BOOKING_NOTES) : null,
            createdAt: new Date(Math.min(nowMs - 60 * 1000, Math.max(nowMs - bookedAgo, startsAt.getTime() - 60 * 60 * 1000))),
          });
        }
      }
    }
  }
  return { keys, totalSlots };
};

// ---------------------------------------------------------------------------
// Database steps

const chunk = <T>(items: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const createInChunks = async <T>(label: string, items: T[], size: number, write: (batch: T[]) => Promise<unknown>) => {
  for (const [i, batch] of chunk(items, size).entries()) {
    await write(batch);
    process.stdout.write(`\r  ${label}: ${Math.min((i + 1) * size, items.length)}/${items.length}`);
  }
  if (items.length) process.stdout.write("\n");
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

const databaseSize = async () => {
  const [row] = await prisma.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database())::bigint AS bytes`;
  return Number(row.bytes);
};

/** Neon exposes its storage cap as a setting; elsewhere there is none. */
const storageCap = async () => {
  try {
    const [row] = await prisma.$queryRawUnsafe<Record<string, string>[]>("SHOW neon.max_cluster_size");
    const value = Object.values(row)[0];
    const match = /^(\d+)\s*(MB|GB)$/i.exec(value ?? "");
    if (!match) return null;
    return Number(match[1]) * (match[2].toUpperCase() === "GB" ? 1024 : 1) * 1024 * 1024;
  } catch {
    return null;
  }
};

const resolveOwner = async () => {
  const user = await prisma.user.findUnique({ where: { email: OWNER_EMAIL }, include: { salonOwner: true } });
  if (!user) throw new Error(`No user with email ${OWNER_EMAIL}. Register that account first.`);
  return user;
};

/**
 * The owner must be a verified, approved, active salon owner, or the salons
 * would be invisible or unmanageable. Only fixes what is missing.
 */
const ensureOwnerReady = async (user: Awaited<ReturnType<typeof resolveOwner>>) => {
  if (user.role === UserRole.ADMIN || user.role === UserRole.AGENT) {
    throw new Error(`${OWNER_EMAIL} is an ${user.role}; refusing to turn it into a salon owner.`);
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      role: UserRole.SALON_OWNER,
      status: UserStatus.ACTIVE,
      isDeleted: false,
      emailVerified: true,
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
    },
  });
  const salonOwner = await prisma.salonOwner.upsert({
    where: { userId: user.id },
    update: { applicationStatus: "APPROVED", verificationStatus: true, rejectionReason: null },
    create: { userId: user.id, applicationStatus: "APPROVED", verificationStatus: true, businessName: user.name },
  });
  return { userId: user.id, salonOwnerId: salonOwner.id };
};

const TEMP_FK_INDEXES = [
  ["seed_tmp_appointments_slot", "appointments", "slotId"],
  ["seed_tmp_appointments_service", "appointments", "serviceId"],
  ["seed_tmp_appointments_staff", "appointments", "staffId"],
  ["seed_tmp_appointments_counter", "appointments", "counterId"],
  ["seed_tmp_slots_service", "slots", "serviceId"],
  ["seed_tmp_reviews_staff", "reviews", "staffId"],
  ["seed_tmp_reviews_customer", "reviews", "customerId"],
] as const;

const backupAndDelete = async (salonOwnerId: string | null) => {
  const salons = salonOwnerId
    ? await prisma.salon.findMany({ where: { ownerId: salonOwnerId }, select: { id: true } })
    : [];
  const salonIds = salons.map((s) => s.id);
  const seedUsers = await prisma.user.count({ where: { email: { endsWith: `@${SEED_EMAIL_DOMAIN}` } } });

  if (salonIds.length) {
    // The seed's own salons are not worth a backup; anything else is.
    const foreign = await prisma.appointment.count({
      where: { salonId: { in: salonIds }, customer: { email: { not: { endsWith: `@${SEED_EMAIL_DOMAIN}` } } } },
    });
    const backup = await prisma.salon.findMany({
      where: { id: { in: salonIds } },
      include: {
        services: true,
        counters: true,
        staff: true,
        appointments: { where: { customer: { email: { not: { endsWith: `@${SEED_EMAIL_DOMAIN}` } } } }, include: { payment: true, review: true } },
      },
    });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `salons-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ owner: OWNER_EMAIL, salons: backup }, null, 1));
    console.log(`  backup: ${salonIds.length} salon(s), ${foreign} booking(s) by real customers -> ${path.relative(process.cwd(), file)}`);

    // Money first: a deposit held on a booking that is about to disappear goes
    // back to the customer's spendable balance.
    const held = await prisma.appointment.findMany({
      where: { salonId: { in: salonIds }, depositStatus: DepositStatus.HELD, depositMinor: { gt: 0 } },
      select: { id: true },
    });
    for (const a of held) {
      await prisma.$transaction((tx) => settleReleasedTx(tx, a.id), { timeout: 15000, maxWait: 10000 });
    }
    if (held.length) console.log(`  released ${held.length} held deposit(s) back to customer wallets`);
  }

  // These foreign keys have no index, so each deleted parent row would scan
  // the whole child table - hours for a seeded dataset. Index them for the
  // teardown only; Prisma does not know about these and they are dropped below.
  for (const [name, table, column] of TEMP_FK_INDEXES) {
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} ("${column}")`);
  }
  try {
    if (salonIds.length) {
      const ids = salonIds;
      await prisma.$executeRaw`DELETE FROM reviews WHERE "salonId" = ANY(${ids})`;
      await prisma.$executeRaw`DELETE FROM payments WHERE "appointmentId" IN (SELECT id FROM appointments WHERE "salonId" = ANY(${ids}))`;
      await prisma.$executeRaw`DELETE FROM appointments WHERE "salonId" = ANY(${ids})`;
      await prisma.$executeRaw`DELETE FROM slots WHERE "salonId" = ANY(${ids})`;
      await prisma.$executeRaw`DELETE FROM staff_services WHERE "serviceId" IN (SELECT id FROM services WHERE "salonId" = ANY(${ids}))`;
      await prisma.$executeRaw`DELETE FROM services WHERE "salonId" = ANY(${ids})`;
      await prisma.$executeRaw`DELETE FROM staff WHERE "salonId" = ANY(${ids})`;
      await prisma.$executeRaw`DELETE FROM counters WHERE "salonId" = ANY(${ids})`;
      await prisma.$executeRaw`DELETE FROM salons WHERE id = ANY(${ids})`;
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${SEED_EMAIL_DOMAIN}` } } });
  } finally {
    for (const [name] of TEMP_FK_INDEXES) await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS ${name}`);
  }
  console.log(`  deleted ${salonIds.length} salon(s) and ${seedUsers} seeded user(s)`);

  // Make the space those rows held reusable before refilling it, so a re-run
  // does not briefly need twice the storage.
  if (salonIds.length > 50) {
    for (const table of ["slots", "appointments", "reviews", "payments", "services", "staff_services", "staff", "counters", "salons", "users"]) {
      await prisma.$executeRawUnsafe(`VACUUM ${table}`).catch(() =>
        console.warn(`  VACUUM ${table} skipped; autovacuum will get to it`),
      );
    }
  }
};

type SlotTemplate = { salonId: string; serviceId: string; counterId: string; dur: number; dow: number; starts: number[] };

const insertSlots = async (plan: Plan) => {
  const first = isoDay(0);
  const last = isoDay(SLOT_DAYS - 1);
  let inserted = 0;
  for (const batch of chunk(plan.salons, 40)) {
    const templates: SlotTemplate[] = [];
    for (const salon of batch) {
      for (const service of salon.services) {
        for (const dow of service.days) {
          const hours = salon.hours[WEEKDAYS[dow]];
          const starts = startsFor(hours.open, hours.close, service.duration);
          if (starts.length) {
            templates.push({ salonId: salon.id, serviceId: service.id, counterId: service.counterId, dur: service.duration, dow, starts });
          }
        }
      }
    }
    // Expanded in the database: one row per day x start, numbered in start
    // order the way bulk-create numbers them.
    inserted += await prisma.$executeRaw`
      INSERT INTO slots (id, "salonId", "serviceId", "counterId", date, "startTime", "endTime", "sequenceNo", "updatedAt")
      SELECT gen_random_uuid()::text, t."salonId", t."serviceId", t."counterId", d.day,
             lpad((u.s / 60)::text, 2, '0') || ':' || lpad((u.s % 60)::text, 2, '0'),
             lpad(((u.s + t.dur) / 60)::text, 2, '0') || ':' || lpad(((u.s + t.dur) % 60)::text, 2, '0'),
             u.ord::int, now()
      FROM jsonb_to_recordset(${JSON.stringify(templates)}::jsonb)
             AS t("salonId" text, "serviceId" text, "counterId" text, dur int, dow int, starts int[])
      JOIN generate_series(${first}::timestamp, ${last}::timestamp, interval '1 day') AS d(day)
        ON extract(dow FROM d.day)::int = t.dow
      CROSS JOIN LATERAL unnest(t.starts) WITH ORDINALITY AS u(s, ord)`;
    process.stdout.write(`\r  slots: ${inserted}`);
  }
  process.stdout.write("\n");
  return inserted;
};

const bookUpcoming = async (plan: Plan, keys: BookedKey[], token: (r: Rng) => string) => {
  const services = new Map(plan.salons.flatMap((s) => s.services.map((sv) => [sv.id, sv] as const)));
  const r = rngFor("upcoming-tokens");
  let booked = 0;
  for (const batch of chunk(keys, 2000)) {
    const rows = await prisma.$queryRaw<{ id: string; salonId: string; serviceId: string; counterId: string; date: Date; startTime: string; endTime: string; sequenceNo: number }[]>`
      UPDATE slots s SET status = 'BOOKED', "isBooked" = true, "updatedAt" = now()
      FROM jsonb_to_recordset(${JSON.stringify(batch.map((k) => ({ salonId: k.salonId, serviceId: k.serviceId, day: k.day, startTime: k.startTime })))}::jsonb)
             AS b("salonId" text, "serviceId" text, day timestamp, "startTime" text)
      WHERE s."salonId" = b."salonId" AND s."serviceId" = b."serviceId" AND s.date = b.day AND s."startTime" = b."startTime"
      RETURNING s.id, s."salonId", s."serviceId", s."counterId", s.date, s."startTime", s."endTime", s."sequenceNo"`;
    const byKey = new Map(batch.map((k) => [`${k.serviceId}|${k.day}|${k.startTime}`, k]));
    const appointments: Prisma.AppointmentCreateManyInput[] = rows.map((slot) => {
      const key = byKey.get(`${slot.serviceId}|${slot.date.toISOString().slice(0, 10)}|${slot.startTime}`)!;
      const service = services.get(slot.serviceId)!;
      return {
        customerId: key.customerId,
        salonId: slot.salonId,
        serviceId: slot.serviceId,
        staffId: key.staffId,
        counterId: slot.counterId,
        appointmentDate: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: AppointmentStatus.CONFIRMED,
        notes: key.notes,
        slotId: slot.id,
        token: token(r),
        serialNumber: slot.sequenceNo,
        totalMinor: service.priceMinor,
        depositMinor: 0,
        depositStatus: DepositStatus.NONE,
        source: AppointmentSource.PLATFORM,
        bookedVia: key.bookedVia,
        // Stamped so the reminder job never emails a seeded customer.
        reminder24At: key.createdAt,
        reminder2hAt: key.createdAt,
        createdAt: key.createdAt,
        updatedAt: key.createdAt,
      };
    });
    await prisma.appointment.createMany({ data: appointments });
    booked += appointments.length;
    process.stdout.write(`\r  upcoming bookings: ${booked}/${keys.length}`);
  }
  process.stdout.write("\n");
  return booked;
};

const refreshRatings = async (salonIds: string[]) => {
  await prisma.$executeRaw`
    UPDATE salons s SET rating = r.avg, "totalReviews" = r.n
    FROM (SELECT "salonId", avg(rating)::float8 AS avg, count(*)::int AS n
          FROM reviews WHERE "salonId" = ANY(${salonIds}) GROUP BY "salonId") r
    WHERE s.id = r."salonId"`;
  await prisma.$executeRaw`
    UPDATE staff st SET rating = r.avg, "totalReviews" = r.n
    FROM (SELECT "staffId", avg(rating)::float8 AS avg, count(*)::int AS n
          FROM reviews WHERE "salonId" = ANY(${salonIds}) AND "staffId" IS NOT NULL GROUP BY "staffId") r
    WHERE st.id = r."staffId"`;
};

/**
 * The promise the data makes: from any street in the city there is an active
 * salon within 1 km. Checked with the same PostGIS predicate GET /salons uses.
 */
const verifyCoverage = async (probes: [number, number][]) => {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT (SELECT count(*)::int FROM salons s
             WHERE s."isDeleted" = false AND s.status = 'ACTIVE'
               AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
               AND ST_DWithin(${SALON_GEOG}, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)::geography, ${NEARBY_RADIUS_M}::float8)) AS n
    FROM jsonb_to_recordset(${JSON.stringify(probes.map(([lat, lng]) => ({ lat, lng })))}::jsonb) AS p(lat float8, lng float8)`;
  const counts = rows.map((row) => row.n).sort((a, b) => a - b);
  const empty = counts.filter((n) => n === 0).length;
  console.log(
    `  coverage: ${probes.length - empty}/${probes.length} random street points have a salon within 1 km ` +
      `(min ${counts[0]}, median ${counts[Math.floor(counts.length / 2)]}, max ${counts[counts.length - 1]})`,
  );
  return empty;
};

// ---------------------------------------------------------------------------

const main = async () => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as { salons: Location[]; probes: [number, number][] };
  const user = await resolveOwner();

  console.log(`${APPLY ? "Seeding" : "Dry run for"} ${data.salons.length} Dhaka salons owned by ${OWNER_EMAIL}`);
  console.log(`  slots from ${isoDay(0)} to ${isoDay(SLOT_DAYS - 1)} (Dhaka dates)`);

  const existing = user.salonOwner
    ? await prisma.salon.findMany({
        where: { ownerId: user.salonOwner.id },
        select: { id: true, _count: { select: { appointments: true, slots: true } } },
      })
    : [];
  console.log(
    `  will delete: ${existing.length} salon(s) of this owner with ${existing.reduce((n, s) => n + s._count.appointments, 0)} booking(s) ` +
      `and ${existing.reduce((n, s) => n + s._count.slots, 0)} slot(s), plus users on @${SEED_EMAIL_DOMAIN}`,
  );

  const placeholderOwner = { userId: user.id, salonOwnerId: user.salonOwner?.id ?? "pending" };
  const plan = buildPlan(data.salons, data.probes, placeholderOwner);
  const tokens = new Set((await prisma.appointment.findMany({ where: { token: { not: null } }, select: { token: true } })).map((a) => a.token!));
  const token = makeTokenFactory(tokens);
  const history = buildHistory(plan, token);
  const { keys, totalSlots } = buildBookedKeys(plan);

  const counts = {
    salons: plan.salons.length,
    services: plan.salons.reduce((n, s) => n + s.services.length, 0),
    counters: plan.salons.reduce((n, s) => n + s.counters.length, 0),
    staff: plan.staffUsers.length,
    customers: plan.customers.length,
    slots: totalSlots,
    upcomingBookings: keys.length,
    pastBookings: history.appointments.length,
    reviews: history.reviews.length,
  };
  console.table(counts);
  const byType = plan.salons.reduce<Record<string, number>>((acc, s) => ((acc[s.type] = (acc[s.type] ?? 0) + 1), acc), {});
  console.log("  salon types:", byType);

  const projected =
    counts.slots * ROW_BYTES.slot +
    (counts.upcomingBookings + counts.pastBookings) * ROW_BYTES.appointment +
    counts.reviews * ROW_BYTES.review +
    history.payments.length * ROW_BYTES.payment +
    (counts.salons + counts.services + counts.counters + counts.staff * 3 + counts.customers) * ROW_BYTES.other;
  const [size, cap] = await Promise.all([databaseSize(), storageCap()]);
  console.log(`  database now ${mb(size)}, this seed adds about ${mb(projected)}${cap ? ` (storage cap ${mb(cap)})` : ""}`);
  if (cap && size + projected > cap * MAX_CAP_SHARE && !FORCE) {
    throw new Error(`That would use more than ${MAX_CAP_SHARE * 100}% of the storage cap. Pass --force to go ahead anyway.`);
  }

  if (!APPLY) {
    const sample = plan.salons.filter((_, i) => i % Math.ceil(plan.salons.length / 8) === 0);
    for (const s of sample) {
      console.log(`\n  ${s.name} [${s.type}, tier ${s.tier}]  ${s.loc.lat}, ${s.loc.lng}`);
      console.log(`    ${s.row.address}`);
      console.log(`    ${s.services.map((sv) => `${sv.name} ৳${sv.priceMinor / 100}`).join(" | ")}`);
    }
    console.log("\nDry run only. Re-run with --apply to write.");
    return;
  }

  const started = Date.now();
  console.log("\n1/6 owner");
  const owner = await ensureOwnerReady(user);
  for (const salon of plan.salons) salon.row.ownerId = owner.salonOwnerId;

  console.log("2/6 removing old salons");
  await backupAndDelete(user.salonOwner?.id ?? owner.salonOwnerId);

  console.log("3/6 users, salons, services, staff");
  await createInChunks("users", [...plan.customers, ...plan.staffUsers], 1000, (batch) =>
    prisma.user.createMany({ data: batch }),
  );
  await createInChunks("salons", plan.salons.map((s) => s.row), 200, (batch) => prisma.salon.createMany({ data: batch }));
  await createInChunks("counters", plan.salons.flatMap((s) => s.counters.map(({ def, ...c }) => c)), 1000, (batch) =>
    prisma.counter.createMany({ data: batch }),
  );
  await createInChunks("services", plan.salons.flatMap((s) => s.services.map(({ counterId, days, ...sv }) => sv)), 1000, (batch) =>
    prisma.service.createMany({ data: batch }),
  );
  const staffRows = plan.salons.flatMap((salon) =>
    salon.staff.map((s, i): Prisma.StaffCreateManyInput => {
      const r = rngFor(`staff:${salon.index}:${i}`);
      const years = int(r, 2, 18);
      return {
        id: s.id,
        userId: s.userId,
        salonId: salon.id,
        speciality: s.title,
        experience: years,
        bio: `${s.fullName.split(" ")[0]} has ${years} years of experience as a ${s.title.toLowerCase()}${chance(r, 0.4) ? ", and trains the juniors" : ""}.`,
        status: "AVAILABLE",
      };
    }),
  );
  await createInChunks("staff", staffRows, 1000, (batch) => prisma.staff.createMany({ data: batch }));
  const links = plan.salons.flatMap((salon) =>
    salon.staff.flatMap((s) =>
      salon.services.filter((sv) => s.categories.includes(sv.category)).map((sv) => ({ staffId: s.id, serviceId: sv.id })),
    ),
  );
  await createInChunks("staff services", links, 2000, (batch) => prisma.staffService.createMany({ data: batch }));

  console.log("4/6 slots for the next 30 days");
  await insertSlots(plan);
  await bookUpcoming(plan, keys, token);

  console.log("5/6 history and reviews");
  await createInChunks("past bookings", history.appointments, 2000, (batch) => prisma.appointment.createMany({ data: batch }));
  await createInChunks("payments", history.payments, 2000, (batch) => prisma.payment.createMany({ data: batch }));
  await createInChunks("reviews", history.reviews, 2000, (batch) => prisma.review.createMany({ data: batch }));
  await refreshRatings(plan.salons.map((s) => s.id));

  console.log("6/6 checks");
  const empty = await verifyCoverage(plan.probes);
  const after = await databaseSize();
  const [slotRows, bookedRows] = await Promise.all([
    prisma.slot.count({ where: { salonId: { in: plan.salons.map((s) => s.id) } } }),
    prisma.slot.count({ where: { salonId: { in: plan.salons.map((s) => s.id) }, isBooked: true } }),
  ]);
  console.log(`  ${slotRows} slots (${bookedRows} booked), database now ${mb(after)}${cap ? ` of ${mb(cap)}` : ""}`);
  console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)} s.${empty ? ` WARNING: ${empty} probe point(s) have no salon within 1 km.` : ""}`);
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
