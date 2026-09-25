/**
 * Load check for the booking assistant: N guest conversations at once, each
 * tapping the whole funnel —
 *
 *   start → set_location → find_nearby → choose_salon → book → choose_date
 *         → choose_service → (choose_counter) → choose_slot
 *
 * — then p50 / p95 / max per step. The target is launch-shaped, not a stress
 * test: 50 concurrent conversations, p95 under 2 s for a tap turn.
 *
 *   npm run assistant:load -- --url http://localhost:5055/api/v1 --conversations 50
 *   npm run assistant:load -- --ids load-ids.json --purge
 *
 * No dependency: Node's own fetch. Guests take no slot holds and cannot book,
 * so the only writes are the conversations and their messages. `--purge`
 * backdates exactly the conversations this run created and runs the real
 * retention job over them, which is also how that job gets exercised.
 *
 * With INTERNAL_API_KEY set (same value as the API under test), each guest
 * arrives from its own address in 198.18.0.0/15 — the benchmarking range — the
 * way real visitors do through Vercel. Without it every guest shares one
 * limiter bucket and the run measures the 429 path instead.
 */
import "../config";

type Args = {
  url: string;
  conversations: number;
  lat: number;
  lng: number;
  salon?: string;
  ids?: string;
  purge: boolean;
};

const parseArgs = (): Args => {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    url: get("url") ?? process.env.LOAD_URL ?? "http://localhost:5000/api/v1",
    conversations: Number(get("conversations") ?? 50),
    // Dhanmondi, as in the Phase 1 checks.
    lat: Number(get("lat") ?? 23.7465),
    lng: Number(get("lng") ?? 90.376),
    salon: get("salon"),
    ids: get("ids"),
    purge: argv.includes("--purge"),
  };
};

type Block = { type: string; [key: string]: unknown };
type Turn = {
  conversationId?: string;
  anonymousId?: string | null;
  messages?: Array<{ role: string; blocks?: Block[]; latencyMs?: number | null }>;
};

type Sample = {
  step: string;
  ms: number;
  serverMs: number | null;
  ok: boolean;
  status: number;
  /** The API's message when it refused, so a 500 in the table has a cause. */
  error?: string;
};

const blocksOf = (turn: Turn): Block[] =>
  (turn.messages ?? []).filter((m) => m.role === "ASSISTANT").flatMap((m) => m.blocks ?? []);

const find = (turn: Turn, type: string) => blocksOf(turn).find((b) => b.type === type);

const conversation = async (index: number, args: Args, samples: Sample[]) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const internalKey = process.env.INTERNAL_API_KEY;
  if (internalKey) {
    headers["X-Client-IP"] = `198.18.${Math.floor(index / 250)}.${(index % 250) + 1}`;
    headers["X-Internal-Key"] = internalKey;
  }

  let cid: string | undefined;

  const call = async (step: string, path: string, body: unknown): Promise<Turn | null> => {
    const started = performance.now();
    let status = 0;
    try {
      const res = await fetch(`${args.url}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      status = res.status;
      const json = (await res.json()) as { success: boolean; message?: string; data?: Turn };
      const ms = performance.now() - started;
      const serverMs =
        json.data?.messages?.find((m) => m.role === "ASSISTANT")?.latencyMs ?? null;
      const ok = res.ok && json.success;
      samples.push({ step, ms, serverMs, ok, status, ...(ok ? {} : { error: json.message }) });
      return ok ? (json.data ?? null) : null;
    } catch (error) {
      samples.push({
        step,
        ms: performance.now() - started,
        serverMs: null,
        ok: false,
        status,
        error: (error as Error).message,
      });
      return null;
    }
  };

  const act = (step: string, action: Record<string, unknown>) =>
    call(step, `/assistant/conversations/${cid}/actions`, { action });

  const created = await call("start", "/assistant/conversations", { action: { type: "start" } });
  if (!created?.conversationId) return null;
  cid = created.conversationId;
  if (created.anonymousId) headers["X-Assistant-Key"] = created.anonymousId;

  const located = await act("set_location", {
    type: "set_location",
    lat: args.lat,
    lng: args.lng,
    label: "Load test",
  });
  if (!located) return cid;

  const nearby = await act("find_nearby", { type: "find_nearby" });
  const cards = (find(nearby ?? {}, "salon_carousel")?.salons ?? []) as Array<{
    id: string;
    serviceCount: number;
    counterCount: number;
  }>;
  const salonId =
    args.salon ?? cards.find((c) => c.serviceCount > 0 && c.counterCount > 0)?.id;
  if (!salonId) return cid;

  if (!(await act("choose_salon", { type: "choose_salon", salonId }))) return cid;

  const book = await act("book", { type: "book" });
  const dates = (find(book ?? {}, "date_picker")?.dates ?? []) as Array<{ date: string }>;
  if (!dates.length) return cid;

  // Spread the load over the days on offer, as real customers would.
  const date = dates[index % dates.length].date;
  const day = await act("choose_date", { type: "choose_date", date });
  const services = (find(day ?? {}, "service_picker")?.services ?? []) as Array<{ id: string }>;
  if (!services.length) return cid;

  let step = await act("choose_service", {
    type: "choose_service",
    serviceId: services[index % services.length].id,
  });

  const counters = (find(step ?? {}, "counter_picker")?.counters ?? []) as Array<{ id: string }>;
  if (counters.length) {
    step = await act("choose_counter", {
      type: "choose_counter",
      counterId: counters[index % counters.length].id,
    });
  }

  const groups = (find(step ?? {}, "slot_picker")?.groups ?? []) as Array<{
    slots: Array<{ id: string }>;
  }>;
  const slots = groups.flatMap((g) => g.slots);
  if (!slots.length) return cid;

  await act("choose_slot", { type: "choose_slot", slotId: slots[index % slots.length].id });
  return cid;
};

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0;

const report = (samples: Sample[], wallMs: number) => {
  const steps = [...new Set(samples.map((s) => s.step))];
  const rows = [...steps, "ALL TAPS"].map((step) => {
    const set = step === "ALL TAPS" ? samples : samples.filter((s) => s.step === step);
    const ms = set.map((s) => s.ms).sort((a, b) => a - b);
    const server = set
      .map((s) => s.serverMs)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const statuses = [...new Set(set.filter((s) => !s.ok).map((s) => s.status))];
    return {
      step,
      n: set.length,
      failed: set.filter((s) => !s.ok).length + (statuses.length ? ` (${statuses.join(",")})` : ""),
      p50: Math.round(pct(ms, 50)),
      p95: Math.round(pct(ms, 95)),
      max: Math.round(ms[ms.length - 1] ?? 0),
      "server p95": server.length ? Math.round(pct(server, 95)) : "-",
      "under 2s": pct(ms, 95) < 2000 ? "yes" : "NO",
    };
  });
  console.table(rows);

  const errors = new Map<string, number>();
  for (const s of samples.filter((x) => !x.ok)) {
    const key = `${s.step} ${s.status}: ${(s.error ?? "no message").slice(0, 160)}`;
    errors.set(key, (errors.get(key) ?? 0) + 1);
  }
  for (const [key, n] of errors) console.log(`  ${n}× ${key}`);

  console.log(
    `${samples.length} requests in ${(wallMs / 1000).toFixed(1)} s ` +
      `(${(samples.length / (wallMs / 1000)).toFixed(1)} req/s). ` +
      `"server" is the handler's own time (runAction), without the ownership read and the transcript write.`,
  );
};

const purge = async (ids: string[]) => {
  // Loaded only here, so a plain run never opens a database connection.
  const { default: prisma } = await import("../app/shared/prisma");
  const { purgeExpiredConversations } = await import("../app/modules/Assistant/assistant.service");

  const now = new Date();
  const others = await prisma.assistantConversation.count({
    where: { expiresAt: { lt: now }, id: { notIn: ids } },
  });
  const backdated = await prisma.assistantConversation.updateMany({
    where: { id: { in: ids }, userId: null },
    data: { expiresAt: new Date(now.getTime() - 60_000) },
  });
  const messagesBefore = await prisma.assistantMessage.count({
    where: { conversationId: { in: ids } },
  });
  const deleted = await purgeExpiredConversations();
  const left = await prisma.assistantConversation.count({ where: { id: { in: ids } } });
  const messagesLeft = await prisma.assistantMessage.count({
    where: { conversationId: { in: ids } },
  });

  console.log(
    `[purge] backdated ${backdated.count} guest conversation(s) from this run; ` +
      `${others} other expired conversation(s) were already due. ` +
      `retention job deleted ${deleted}; ${left} of this run's conversations and ` +
      `${messagesLeft} of their ${messagesBefore} messages remain.`,
  );
  await prisma.$disconnect();
};

const main = async () => {
  const args = parseArgs();
  const fs = await import("fs");

  if (args.purge) {
    if (!args.ids || !fs.existsSync(args.ids)) {
      console.error("--purge needs --ids <file> from an earlier run");
      process.exit(1);
    }
    await purge(JSON.parse(fs.readFileSync(args.ids, "utf8")) as string[]);
    return;
  }

  if (!process.env.INTERNAL_API_KEY) {
    console.warn(
      "INTERNAL_API_KEY is not set: every conversation shares one limiter bucket, so expect 429s.",
    );
  }

  console.log(`${args.conversations} concurrent conversations against ${args.url}…`);
  const samples: Sample[] = [];
  const started = performance.now();
  const ids = await Promise.all(
    Array.from({ length: args.conversations }, (_, i) => conversation(i, args, samples)),
  );
  const wall = performance.now() - started;

  report(samples, wall);

  const created = ids.filter((id): id is string => Boolean(id));
  console.log(`${created.length} conversations created.`);
  if (args.ids) {
    fs.writeFileSync(args.ids, JSON.stringify(created, null, 2));
    console.log(`Ids written to ${args.ids} — run again with --ids ${args.ids} --purge to remove them.`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
