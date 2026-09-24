/**
 * Who can read, and delete, whose chats. Prints PASS / FAIL per check.
 *
 *   npm run assistant:access -- --url http://localhost:5055/api/v1
 *   npm run assistant:access -- --url … --a <userId> --b <userId> --admin <userId>
 *
 * Always: two guests cannot read or act on each other's conversation, with or
 * without a key; a guest cannot DELETE; /stats refuses a guest.
 *
 * With --a / --b (two accounts, tokens minted locally with JWT_SECRET): neither
 * can read the other's conversation whatever key they send, and A's "Delete my
 * chats" removes A's conversations only — B's still reads. WARNING: that DELETE
 * removes *every* conversation account A has. With --a, /stats must 403 for A;
 * with --admin, it must answer 200.
 *
 * Writes: two guest conversations always, one per account with --a/--b. The
 * guest ids go to --ids <file>, for `npm run assistant:load -- --ids <file> --purge`.
 */
import "../config";
import config from "../config";
import { jwtHelpers } from "../app/helper/jwtHelper";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const URL_BASE = arg("url") ?? process.env.LOAD_URL ?? "http://localhost:5000/api/v1";
let failures = 0;

const check = (name: string, pass: boolean, detail: string) => {
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  (${detail})`);
};

type Who = { key?: string; token?: string };

const request = async (method: string, path: string, who: Who, body?: unknown) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (who.key) headers["X-Assistant-Key"] = who.key;
  if (who.token) headers.Authorization = `Bearer ${who.token}`;
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: { conversationId?: string; anonymousId?: string; deleted?: number };
  };
  return { status: res.status, data: json.data };
};

const start = async (who: Who) => {
  const res = await request("POST", "/assistant/conversations", who, {
    action: { type: "start" },
  });
  return { id: res.data?.conversationId as string, key: res.data?.anonymousId ?? undefined };
};

const tokenFor = async (userId: string) => {
  const { default: prisma } = await import("../app/shared/prisma");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw new Error(`No user ${userId}`);
  return jwtHelpers.createToken(
    { userId: user.id, email: user.email, role: user.role },
    config.jwt.jwt_secret,
    "10m",
  );
};

const main = async () => {
  // Guests.
  const g1 = await start({});
  const g2 = await start({});
  check("guest creates a conversation", Boolean(g1.id && g1.key && g2.id && g2.key), "two guests");

  let r = await request("GET", `/assistant/conversations/${g1.id}`, { key: g1.key });
  check("guest reads own conversation", r.status === 200, `${r.status}`);
  r = await request("GET", `/assistant/conversations/${g2.id}`, { key: g1.key });
  check("guest 1 cannot read guest 2", r.status === 404, `${r.status}`);
  r = await request("GET", `/assistant/conversations/${g1.id}`, { key: g2.key });
  check("guest 2 cannot read guest 1", r.status === 404, `${r.status}`);
  r = await request("GET", `/assistant/conversations/${g1.id}`, {});
  check("no key cannot read", r.status === 404, `${r.status}`);
  r = await request("POST", `/assistant/conversations/${g2.id}/actions`, { key: g1.key }, {
    action: { type: "restart" },
  });
  check("guest 1 cannot act on guest 2", r.status === 404, `${r.status}`);
  r = await request("DELETE", "/assistant/conversations", { key: g1.key });
  check("guest cannot DELETE", r.status === 401, `${r.status}`);
  r = await request("GET", "/assistant/stats", { key: g1.key });
  check("/stats refuses a guest", r.status === 401, `${r.status}`);

  const idsFile = arg("ids");
  if (idsFile) {
    const fs = await import("fs");
    fs.writeFileSync(idsFile, JSON.stringify([g1.id, g2.id], null, 2));
  }

  // Accounts.
  const aId = arg("a");
  const bId = arg("b");
  const adminId = arg("admin");

  if (aId) {
    const a = await tokenFor(aId);
    r = await request("GET", "/assistant/stats", { token: a });
    check("/stats refuses a non-admin", r.status === 403, `${r.status}`);

    if (bId) {
      const b = await tokenFor(bId);
      const ca = await start({ token: a });
      const cb = await start({ token: b });

      r = await request("GET", `/assistant/conversations/${cb.id}`, { token: a, key: g1.key });
      check("A cannot read B's (even with a guest key)", r.status === 404, `${r.status}`);
      r = await request("GET", `/assistant/conversations/${ca.id}`, { token: b, key: g2.key });
      check("B cannot read A's (even with a guest key)", r.status === 404, `${r.status}`);
      r = await request("GET", `/assistant/conversations/${ca.id}`, { key: g1.key });
      check("a guest key cannot read A's", r.status === 404, `${r.status}`);

      r = await request("DELETE", "/assistant/conversations", { token: a });
      check("A deletes their chats", r.status === 200, `${r.status}, deleted ${r.data?.deleted}`);
      r = await request("GET", `/assistant/conversations/${ca.id}`, { token: a });
      check("A's conversation is gone", r.status === 404, `${r.status}`);
      r = await request("GET", `/assistant/conversations/${cb.id}`, { token: b });
      check("B's conversation survived", r.status === 200, `${r.status}`);
      r = await request("GET", `/assistant/conversations/${g2.id}`, { key: g2.key });
      check("a guest's conversation survived", r.status === 200, `${r.status}`);
    }
  }

  if (adminId) {
    r = await request("GET", "/assistant/stats", { token: await tokenFor(adminId) });
    check("/stats answers ADMIN", r.status === 200, `${r.status}`);
  }

  console.log(failures ? `${failures} check(s) FAILED` : "All checks passed.");
  process.exit(failures ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
