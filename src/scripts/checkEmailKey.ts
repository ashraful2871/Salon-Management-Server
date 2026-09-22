/**
 * Answers one question - "is this Resend key alive, and what may it send as?" -
 * without sending anything.
 *
 *   npm run check:email                 # checks RESEND_API_KEY from .env
 *   npm run check:email -- re_xxxxxxxx  # checks a key you just created
 *
 * This exists because `API key is invalid` and `the domain is not verified`
 * arrive at the same place - a failed receipt in a production log - and are
 * completely different problems. Asking Resend which domains a key can see
 * separates them in one request, and costs neither an email nor a deploy.
 */
import crypto from "crypto";
import config from "../config";

type Domain = {
  name?: string;
  status?: string;
  region?: string;
};

const ENDPOINT = "https://api.resend.com/domains";

/** First 7 and last 4 characters plus a hash: comparable, never usable. */
const fingerprint = (key: string) =>
  `${key.slice(0, 7)}...${key.slice(-4)} (${key.length} chars) #${crypto
    .createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 8)}`;

const domainOf = (from: string) => {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  return address.split("@")[1]?.trim().toLowerCase() ?? "";
};

const main = async () => {
  const key = (process.argv[2] ?? config.email.resendApiKey).trim();

  if (!key) {
    console.error("No key to check.");
    console.error("Set RESEND_API_KEY in .env, or pass one:");
    console.error("  npm run check:email -- re_xxxxxxxx");
    process.exit(1);
  }

  console.log(`key  : ${fingerprint(key)}`);
  console.log(`from : ${config.email.from}`);
  console.log("");

  if (!key.startsWith("re_")) {
    console.error('This does not start with "re_", so it is not a Resend API key.');
    process.exit(1);
  }

  let response: Response;

  try {
    response = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error(
      `Could not reach ${ENDPOINT}: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("That is a network problem, not a key problem.");
    process.exit(1);
  }

  const body = (await response.json().catch(() => ({}))) as {
    data?: Domain[];
    message?: string;
    name?: string;
  };

  if (response.status === 401) {
    console.error("DEAD - Resend does not recognise this key.");
    console.error("");
    console.error("It was deleted, regenerated, or never fully copied. A key is");
    console.error("shown once, at creation, and cannot be read back afterwards -");
    console.error("the API Keys list only shows a masked version of it.");
    console.error("");
    console.error("Fix: Resend -> API Keys -> Create API Key, copy the value from");
    console.error("the creation dialog, and check it with this command again.");
    process.exit(1);
  }

  // A sending-only key is not allowed to list domains. That is a 403 with the
  // key accepted - which is all this command set out to establish.
  if (response.status === 403 || body?.name === "restricted_api_key") {
    console.log("ALIVE - accepted, but restricted to sending, so it cannot list");
    console.log("domains. That permission is the right one for this server.");
    console.log("");
    console.log("Run `npm run test:email -- you@example.com` to confirm delivery.");
    process.exit(0);
  }

  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${body?.message ?? body?.name ?? "unknown error"}`);
    process.exit(1);
  }

  const domains = body?.data ?? [];

  console.log("ALIVE - Resend accepted this key.");
  console.log("");

  if (domains.length === 0) {
    console.log("It owns no domains yet, so it can only send from");
    console.log("onboarding@resend.dev, and only to the account owner's address.");
    process.exit(0);
  }

  console.log("Domains this key can see:");
  for (const domain of domains) {
    const status = domain.status ?? "unknown";
    const marker = status === "verified" ? "OK     " : "PENDING";
    console.log(`  ${marker} ${domain.name}${domain.region ? ` (${domain.region})` : ""} - ${status}`);
  }
  console.log("");

  const sending = domainOf(config.email.from);
  const match = domains.find((domain) => domain.name?.toLowerCase() === sending);

  if (!match) {
    console.error(`EMAIL_FROM sends as "${sending}", which is not in that list.`);
    console.error("This key belongs to a different Resend account than the one");
    console.error("that verified the domain. Create the key in the owning account.");
    process.exit(1);
  }

  if (match.status !== "verified") {
    console.error(`"${sending}" is ${match.status}, not verified. Finish its DNS records first.`);
    process.exit(1);
  }

  console.log(`Ready: this key may send as "${sending}".`);
  process.exit(0);
};

void main();
