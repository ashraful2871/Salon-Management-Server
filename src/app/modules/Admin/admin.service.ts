import { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { audit, AuditCtx } from "../../utils/audit";
import { mfaStatus } from "../../utils/mfa";
import type { AdminContext } from "./admin.middleware";
import { can, normalizeArea, Permission } from "./admin.permissions";
import { NOTE_ENTITY_TYPES } from "./admin.validation";

// Frontend admin routes are built in Phase 3; these hrefs are where they go.
const HREF = {
  user: (id: string) => `/dashboard/admin/users/${id}`,
  salon: (id: string) => `/dashboard/admin/salons/${id}`,
  booking: (id: string) => `/dashboard/admin/bookings/${id}`,
  intent: (id: string) => `/dashboard/admin/finance/intents/${id}`,
  payout: (id: string) => `/dashboard/admin/finance/payouts/${id}`,
};

// ---------------------------------------------------------------- me

const getMe = async (admin: AdminContext) => {
  const user = await prisma.user.findUnique({
    where: { id: admin.userId },
    select: { name: true, email: true },
  });
  return {
    userId: admin.userId,
    name: user?.name ?? null,
    email: user?.email ?? null,
    accountRole: admin.accountRole,
    adminRole: admin.adminRole ?? null,
    permissions: admin.permissions,
    area: admin.area ?? null,
    mfa: await mfaStatus(admin.userId),
  };
};

// ---------------------------------------------------------------- search

export const maskEmail = (email: string | null | undefined) => {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
};

export const maskPhone = (phone: string | null | undefined) => {
  if (!phone) return null;
  const digits = phone.replace(/\s+/g, "");
  return digits.length <= 4 ? "****" : `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
};

type SearchHit = {
  kind: "user" | "salon" | "booking" | "intent" | "payout";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const DIGITS = /^\+?\d{6,}$/;
const TAKE = 5;

const search = async (admin: AdminContext, rawQ: string): Promise<SearchHit[]> => {
  const q = rawQ.trim();
  const has = (p: Permission) => can(admin, p);
  const pii = has("users.view_pii");
  const area = admin.accountRole === "AGENT" && admin.area ? normalizeArea(admin.area) : null;

  const userSelect = { id: true, name: true, email: true, phone: true, role: true } as const;
  const toUserHit = (u: { id: string; name: string; email: string; phone: string | null; role: string }): SearchHit => ({
    kind: "user",
    id: u.id,
    title: u.name,
    subtitle: [
      u.role,
      pii ? u.email : maskEmail(u.email),
      pii ? u.phone : maskPhone(u.phone),
    ].filter(Boolean).join(" · "),
    href: HREF.user(u.id),
  });

  const salonScope: Prisma.SalonWhereInput = area
    ? { area: { equals: area, mode: "insensitive" } }
    : {};
  const salonSelect = { id: true, name: true, area: true, status: true } as const;
  const toSalonHit = (s: { id: string; name: string; area: string; status: string }): SearchHit => ({
    kind: "salon",
    id: s.id,
    title: s.name,
    subtitle: `${s.area} · ${s.status}`,
    href: HREF.salon(s.id),
  });

  const bookingSelect = {
    id: true,
    token: true,
    status: true,
    salon: { select: { name: true } },
  } as const;
  const toBookingHit = (a: { id: string; token: string | null; status: string; salon: { name: string } }): SearchHit => ({
    kind: "booking",
    id: a.id,
    title: a.token ?? a.id.slice(0, 8),
    subtitle: `${a.salon.name} · ${a.status}`,
    href: HREF.booking(a.id),
  });

  const intentSelect = { id: true, transactionId: true, status: true, amountMinor: true, purpose: true } as const;
  const toIntentHit = (i: { id: string; transactionId: string; status: string; amountMinor: number; purpose: string }): SearchHit => ({
    kind: "intent",
    id: i.id,
    title: i.transactionId,
    subtitle: `${i.purpose} · ${i.status} · ৳${(i.amountMinor / 100).toFixed(2)}`,
    href: HREF.intent(i.id),
  });

  const none = Promise.resolve([] as SearchHit[]);
  const jobs: Promise<SearchHit[]>[] = [];

  if (/^TKN-/i.test(q)) {
    if (has("bookings.view")) {
      jobs.push(
        prisma.appointment
          .findMany({
            where: { token: { startsWith: q, mode: "insensitive" } },
            select: bookingSelect,
            take: TAKE,
          })
          .then((rows) => rows.map(toBookingHit)),
      );
    }
  } else if (EMAIL.test(q)) {
    if (has("users.view")) {
      jobs.push(
        prisma.user
          .findMany({
            where: { isDeleted: false, email: { contains: q.toLowerCase(), mode: "insensitive" } },
            select: userSelect,
            take: TAKE,
          })
          .then((rows) => rows.map(toUserHit)),
      );
    }
  } else if (DIGITS.test(q)) {
    const digits = q.replace(/^\+/, "");
    jobs.push(
      has("users.view")
        ? prisma.user
            .findMany({
              where: { isDeleted: false, phone: { contains: digits } },
              select: userSelect,
              take: TAKE,
            })
            .then((rows) => rows.map(toUserHit))
        : none,
      has("finance.view")
        ? prisma.paymentIntent
            .findMany({
              where: { transactionId: { contains: digits, mode: "insensitive" } },
              select: intentSelect,
              take: TAKE,
            })
            .then((rows) => rows.map(toIntentHit))
        : none,
    );
  } else if (UUID.test(q)) {
    const id = q.toLowerCase();
    jobs.push(
      has("users.view")
        ? prisma.user.findMany({ where: { id }, select: userSelect }).then((r) => r.map(toUserHit))
        : none,
      has("salons.view")
        ? prisma.salon.findMany({ where: { id, ...salonScope }, select: salonSelect }).then((r) => r.map(toSalonHit))
        : none,
      has("bookings.view")
        ? prisma.appointment.findMany({ where: { id }, select: bookingSelect }).then((r) => r.map(toBookingHit))
        : none,
      has("finance.view")
        ? prisma.paymentIntent.findMany({ where: { id }, select: intentSelect }).then((r) => r.map(toIntentHit))
        : none,
      has("finance.view")
        ? prisma.payout
            .findMany({
              where: { id },
              select: { id: true, status: true, netMinor: true, salon: { select: { name: true } } },
            })
            .then((r) =>
              r.map((p) => ({
                kind: "payout" as const,
                id: p.id,
                title: `Payout · ${p.salon.name}`,
                subtitle: `${p.status} · ৳${(p.netMinor / 100).toFixed(2)}`,
                href: HREF.payout(p.id),
              })),
            )
        : none,
    );
  } else {
    jobs.push(
      has("users.view")
        ? prisma.user
            .findMany({
              where: { isDeleted: false, name: { contains: q, mode: "insensitive" } },
              select: userSelect,
              take: TAKE,
            })
            .then((rows) => rows.map(toUserHit))
        : none,
      has("salons.view")
        ? prisma.salon
            .findMany({
              where: {
                ...salonScope,
                OR: [
                  { name: { contains: q, mode: "insensitive" } },
                  { area: { contains: q, mode: "insensitive" } },
                ],
              },
              select: salonSelect,
              take: TAKE,
            })
            .then((rows) => rows.map(toSalonHit))
        : none,
    );
  }

  return (await Promise.all(jobs)).flat();
};

// ---------------------------------------------------------------- inbox

type InboxItem = {
  key: string;
  count: number;
  oldestAt?: Date | null;
  dueAt?: Date | null;
  tone: "danger" | "warning" | "info";
  href: string;
};

const HOUR = 60 * 60 * 1000;

const inbox = async (admin: AdminContext): Promise<InboxItem[]> => {
  const has = (p: Permission) => can(admin, p);
  const now = Date.now();
  const items: Promise<InboxItem | null>[] = [];

  if (has("salons.review")) {
    items.push(
      (async () => {
        if (admin.accountRole === "AGENT") {
          // Areas are free text; compare normalised in memory. The pending
          // queue is small.
          const area = admin.area ? normalizeArea(admin.area) : null;
          const rows = area
            ? await prisma.salon.findMany({
                where: { status: "PENDING_APPROVAL" },
                select: { area: true, createdAt: true },
              })
            : [];
          const mine = rows.filter((r) => normalizeArea(r.area) === area);
          return {
            key: "salons.pending",
            count: mine.length,
            oldestAt: mine.reduce<Date | null>((m, r) => (!m || r.createdAt < m ? r.createdAt : m), null),
            tone: "warning",
            href: "/dashboard/admin/salons?status=PENDING_APPROVAL",
          };
        }
        const agg = await prisma.salon.aggregate({
          where: { status: "PENDING_APPROVAL" },
          _count: { _all: true },
          _min: { createdAt: true },
        });
        return {
          key: "salons.pending",
          count: agg._count._all,
          oldestAt: agg._min.createdAt,
          tone: "warning",
          href: "/dashboard/admin/salons?status=PENDING_APPROVAL",
        };
      })(),
    );
  }

  if (has("salons.review") && admin.accountRole === "ADMIN") {
    items.push(
      prisma.salonOwner
        .aggregate({
          where: { applicationStatus: "PENDING" },
          _count: { _all: true },
          _min: { createdAt: true },
        })
        .then((agg) => ({
          key: "applications.pending",
          count: agg._count._all,
          oldestAt: agg._min.createdAt,
          tone: "warning" as const,
          href: "/dashboard/admin/applications",
        })),
    );
  }

  if (has("appeals.resolve")) {
    items.push(
      prisma.appointment
        .aggregate({
          where: { appealStatus: "PENDING" },
          _count: { _all: true },
          _min: { appealedAt: true },
        })
        .then((agg) => {
          const oldest = agg._min.appealedAt;
          const dueAt = oldest ? new Date(oldest.getTime() + 48 * HOUR) : null;
          return {
            key: "appeals.pending",
            count: agg._count._all,
            oldestAt: oldest,
            dueAt,
            tone: dueAt && dueAt.getTime() < now ? ("danger" as const) : ("warning" as const),
            href: "/dashboard/admin/appeals",
          };
        }),
    );
  }

  if (has("finance.refunds")) {
    // Mirrors getAdminTopups: a refund entry whose status is not COMPLETED or
    // FAILED (missing counts too) is UNKNOWN.
    items.push(
      prisma
        .$queryRaw<{ count: bigint; oldest: Date | null }[]>`
          SELECT count(*) AS count, min(pi."createdAt") AS oldest
          FROM payment_intents pi
          WHERE pi.purpose = 'WALLET_TOPUP'
            AND jsonb_typeof(pi."rawResponse"->'refunds') = 'array'
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(pi."rawResponse"->'refunds') e
              WHERE coalesce(e->>'status', '') NOT IN ('COMPLETED', 'FAILED')
            )`
        .then(([row]) => ({
          key: "topups.unknown_refund",
          count: Number(row?.count ?? 0),
          oldestAt: row?.oldest ?? null,
          tone: "danger" as const,
          href: "/dashboard/admin/finance/topups?refund=UNKNOWN",
        })),
    );
  }

  if (has("finance.view")) {
    items.push(
      prisma.paymentIntent
        .aggregate({
          where: { status: "PENDING", createdAt: { lt: new Date(now - HOUR) } },
          _count: { _all: true },
          _min: { createdAt: true },
        })
        .then((agg) => ({
          key: "intents.stuck_pending",
          count: agg._count._all,
          oldestAt: agg._min.createdAt,
          tone: "warning" as const,
          href: "/dashboard/admin/finance/intents?status=PENDING",
        })),
      prisma.payout
        .aggregate({
          where: { status: "FAILED" },
          _count: { _all: true },
          _min: { createdAt: true },
        })
        .then((agg) => ({
          key: "payouts.failed",
          count: agg._count._all,
          oldestAt: agg._min.createdAt,
          tone: "danger" as const,
          href: "/dashboard/admin/finance/payouts?status=FAILED",
        })),
      prisma.payout
        .aggregate({
          where: { status: "PENDING", createdAt: { lt: new Date(now - 7 * 24 * HOUR) } },
          _count: { _all: true },
          _min: { createdAt: true },
        })
        .then((agg) => ({
          key: "payouts.stale_pending",
          count: agg._count._all,
          oldestAt: agg._min.createdAt,
          tone: "warning" as const,
          href: "/dashboard/admin/finance/payouts?status=PENDING",
        })),
    );
  }

  // Unbalanced ledger, wallet drift, failed jobs and storage arrive in Phase 12.

  return (await Promise.all(items)).filter((i): i is InboxItem => !!i && i.count > 0);
};

// ---------------------------------------------------------------- notes

type NoteEntityType = (typeof NOTE_ENTITY_TYPES)[number];

const NOTE_VIEW_PERMISSION: Record<NoteEntityType, Permission> = {
  user: "users.view",
  salon: "salons.view",
  booking: "bookings.view",
  payout: "finance.view",
  intent: "finance.view",
  wallet: "finance.view",
};

const assertCanNote = (admin: AdminContext, entityType: NoteEntityType) => {
  if (!can(admin, NOTE_VIEW_PERMISSION[entityType])) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Forbidden");
  }
};

const listNotes = async (admin: AdminContext, entityType: NoteEntityType, entityId: string) => {
  assertCanNote(admin, entityType);
  const notes = await prisma.adminNote.findMany({
    where: { entityType, entityId, deletedAt: null },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
  const authors = await prisma.user.findMany({
    where: { id: { in: [...new Set(notes.map((n) => n.authorId))] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(authors.map((a) => [a.id, a.name]));
  return notes.map((n) => ({ ...n, authorName: nameById.get(n.authorId) ?? null }));
};

const createNote = async (
  admin: AdminContext,
  ctx: AuditCtx | undefined,
  input: { entityType: NoteEntityType; entityId: string; body: string; pinned?: boolean },
) => {
  assertCanNote(admin, input.entityType);
  const note = await prisma.adminNote.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      body: input.body,
      pinned: input.pinned ?? false,
      authorId: admin.userId,
    },
  });
  await audit(ctx, {
    action: "note.create",
    entityType: input.entityType,
    entityId: input.entityId,
    after: { noteId: note.id, pinned: note.pinned },
  });
  return note;
};

const NOTE_DELETE_WINDOW_MS = 24 * HOUR;

const deleteNote = async (admin: AdminContext, ctx: AuditCtx | undefined, id: string) => {
  const note = await prisma.adminNote.findFirst({ where: { id, deletedAt: null } });
  if (!note) throw new ApiError(StatusCodes.NOT_FOUND, "Note not found");
  if (note.authorId !== admin.userId) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Only the author can delete a note");
  }
  if (Date.now() - note.createdAt.getTime() > NOTE_DELETE_WINDOW_MS) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Notes can only be deleted within 24 hours");
  }
  await prisma.adminNote.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit(ctx, {
    action: "note.delete",
    entityType: note.entityType,
    entityId: note.entityId,
    before: { noteId: note.id, body: note.body },
  });
};

export const AdminService = {
  getMe,
  search,
  inbox,
  listNotes,
  createNote,
  deleteNote,
};
