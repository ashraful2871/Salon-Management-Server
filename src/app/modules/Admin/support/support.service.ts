import { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../../config";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { audit, AuditCtx } from "../../../utils/audit";
import { sendEmail } from "../../../utils/emailSender";
import { getSupportReplyTemplate } from "../../../utils/emailTemplates";
import { ADMIN_ROLE_PERMISSIONS } from "../admin.permissions";
import { parseListQuery } from "../admin.query";
import { TicketReply, TicketUpdate } from "./support.validation";

type Query = Record<string, string | undefined>;

const HOUR = 60 * 60 * 1000;
/** An OPEN ticket nobody has answered after this long is past its SLA. */
export const SUPPORT_SLA_MS = 24 * HOUR;
const AUTOCLOSE_AFTER_MS = 7 * 24 * HOUR;

const LIST_SELECT = {
  id: true,
  number: true,
  source: true,
  name: true,
  email: true,
  subject: true,
  category: true,
  status: true,
  priority: true,
  assigneeId: true,
  userId: true,
  appointmentId: true,
  firstResponseAt: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SupportTicketSelect;

/** Admin user id → name, for the assignee column and the picker. */
const namesOf = async (ids: (string | null)[]) => {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length) return new Map<string, string>();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
};

const withSla = <T extends { status: string; firstResponseAt: Date | null; createdAt: Date }>(t: T) => ({
  ...t,
  slaBreached: t.status === "OPEN" && !t.firstResponseAt && Date.now() - t.createdAt.getTime() > SUPPORT_SLA_MS,
});

const list = async (adminUserId: string, query: Query) => {
  const { skip, take, orderBy, q, page, limit } = parseListQuery(query, {
    sortable: ["createdAt", "updatedAt", "number", "priority"],
    defaultSort: { field: "createdAt", order: "desc" },
  });

  const base: Prisma.SupportTicketWhereInput[] = [];
  if (query.assignee === "me") base.push({ assigneeId: adminUserId });
  else if (query.assignee === "none") base.push({ assigneeId: null });
  else if (query.assignee) base.push({ assigneeId: query.assignee });
  if (query.category) base.push({ category: query.category });
  if (query.priority) base.push({ priority: query.priority as Prisma.EnumTicketPriorityFilter["equals"] });
  if (q) {
    const n = Number.parseInt(q.replace(/^#/, ""), 10);
    base.push({
      OR: [
        ...(Number.isFinite(n) && /^#?\d+$/.test(q) ? [{ number: n }] : []),
        { subject: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  // Default view: everything still open.
  const statusWhere: Prisma.SupportTicketWhereInput = query.status
    ? { status: query.status as "OPEN" }
    : { status: { in: ["OPEN", "PENDING"] } };
  const where: Prisma.SupportTicketWhereInput = { AND: [...base, statusWhere] };

  const [rows, total, counts] = await Promise.all([
    prisma.supportTicket.findMany({ where, skip, take, orderBy: [orderBy, { number: "desc" }], select: LIST_SELECT }),
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.groupBy({ by: ["status"], where: { AND: base }, _count: { _all: true } }),
  ]);
  const names = await namesOf(rows.map((r) => r.assigneeId));

  return {
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    },
    data: rows.map((r) => ({ ...withSla(r), assigneeName: r.assigneeId ? (names.get(r.assigneeId) ?? null) : null })),
  };
};

const getTicket = async (id: string) => {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id },
    select: { ...LIST_SELECT, messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!ticket) throw new ApiError(StatusCodes.NOT_FOUND, "Ticket not found");

  const [user, booking, names] = await Promise.all([
    ticket.userId
      ? prisma.user.findUnique({
          where: { id: ticket.userId },
          select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
        })
      : null,
    ticket.appointmentId
      ? prisma.appointment.findUnique({
          where: { id: ticket.appointmentId },
          select: {
            id: true,
            token: true,
            status: true,
            appointmentDate: true,
            depositStatus: true,
            salon: { select: { id: true, name: true } },
            service: { select: { name: true } },
          },
        })
      : null,
    namesOf([ticket.assigneeId, ...ticket.messages.map((m) => m.authorId)]),
  ]);

  return {
    ...withSla(ticket),
    assigneeName: ticket.assigneeId ? (names.get(ticket.assigneeId) ?? null) : null,
    messages: ticket.messages.map((m) => ({
      ...m,
      authorName: m.authorType === "ADMIN" && m.authorId ? (names.get(m.authorId) ?? "Admin") : m.authorType === "CUSTOMER" ? ticket.name : "System",
    })),
    user,
    booking,
  };
};

/** Admins who can answer tickets: the assignee picker. */
const assignees = async () => {
  const roles = (Object.keys(ADMIN_ROLE_PERMISSIONS) as (keyof typeof ADMIN_ROLE_PERMISSIONS)[]).filter((r) =>
    ADMIN_ROLE_PERMISSIONS[r].includes("support.reply"),
  );
  return prisma.user.findMany({
    where: { role: "ADMIN", status: "ACTIVE", isDeleted: false, admin: { adminRole: { in: roles } } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
};

/**
 * Adds an admin message. A public reply is emailed to the requester
 * (`Re: [#N] <subject>`, Reply-To CONTACT_INBOX); only when the email goes out
 * is it stamped emailedAt, the first response recorded and OPEN moved to
 * PENDING. An internal note is never emailed.
 */
const reply = async (ctx: AuditCtx | undefined, adminUserId: string, id: string, body: TicketReply) => {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id },
    select: { id: true, number: true, subject: true, name: true, email: true, status: true, firstResponseAt: true },
  });
  if (!ticket) throw new ApiError(StatusCodes.NOT_FOUND, "Ticket not found");

  const message = await prisma.supportMessage.create({
    data: { ticketId: id, authorType: "ADMIN", authorId: adminUserId, body: body.body, internal: body.internal },
  });

  let emailed = false;
  let emailError: string | null = null;
  if (!body.internal) {
    const inbox = config.email.contactInbox?.trim();
    const subject = `Re: [#${ticket.number}] ${ticket.subject}`.replace(/[\r\n]+/g, " ");
    const result = await sendEmail(
      ticket.email,
      subject,
      getSupportReplyTemplate({ name: ticket.name, number: ticket.number, subject: ticket.subject, body: body.body }),
      inbox ? { replyTo: inbox } : {},
    );
    emailed = result.ok;
    if (!result.ok) emailError = result.error;

    if (emailed) {
      const now = new Date();
      await prisma.$transaction([
        prisma.supportMessage.update({ where: { id: message.id }, data: { emailedAt: now } }),
        prisma.supportTicket.update({
          where: { id },
          data: {
            firstResponseAt: ticket.firstResponseAt ?? now,
            ...(ticket.status === "OPEN" ? { status: "PENDING" } : {}),
          },
        }),
      ]);
    }
  } else {
    // Bump updatedAt so the ticket sorts as recently touched.
    await prisma.supportTicket.update({ where: { id }, data: { updatedAt: new Date() } });
  }

  await audit(ctx, {
    action: "ticket.reply",
    entityType: "ticket",
    entityId: id,
    after: { messageId: message.id, internal: body.internal, emailed, number: ticket.number },
  });

  return { message: { ...message, emailedAt: emailed ? new Date() : null }, emailed, emailError };
};

const update = async (ctx: AuditCtx | undefined, id: string, body: TicketUpdate) => {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id },
    select: { status: true, assigneeId: true, priority: true, category: true, number: true },
  });
  if (!ticket) throw new ApiError(StatusCodes.NOT_FOUND, "Ticket not found");

  if (body.assigneeId) {
    const ok = (await assignees()).some((a) => a.id === body.assigneeId);
    if (!ok) throw new ApiError(StatusCodes.BAD_REQUEST, "That admin can't take support tickets");
  }

  const data: Prisma.SupportTicketUpdateInput = {};
  if (body.status && body.status !== ticket.status) {
    data.status = body.status;
    data.resolvedAt = body.status === "RESOLVED" || body.status === "CLOSED" ? new Date() : null;
  }
  if (body.assigneeId !== undefined) data.assigneeId = body.assigneeId;
  if (body.priority) data.priority = body.priority;
  if (body.category) data.category = body.category;

  const updated = await prisma.supportTicket.update({ where: { id }, data, select: LIST_SELECT });

  const before = { status: ticket.status, assigneeId: ticket.assigneeId, priority: ticket.priority, category: ticket.category };
  const after = { status: updated.status, assigneeId: updated.assigneeId, priority: updated.priority, category: updated.category };
  await audit(ctx, {
    action: "ticket.status",
    entityType: "ticket",
    entityId: id,
    before,
    after: { ...after, number: ticket.number },
  });

  const names = await namesOf([updated.assigneeId]);
  return { ...withSla(updated), assigneeName: updated.assigneeId ? (names.get(updated.assigneeId) ?? null) : null };
};

/** Job support.autoclose (daily): RESOLVED for more than 7 days → CLOSED. */
const autoClose = async () => {
  const { count } = await prisma.supportTicket.updateMany({
    where: { status: "RESOLVED", resolvedAt: { lt: new Date(Date.now() - AUTOCLOSE_AFTER_MS) } },
    data: { status: "CLOSED" },
  });
  if (count) console.log(`[jobs] support.autoclose: closed ${count} ticket(s)`);
  return { closed: count };
};

export const AdminSupportService = { list, getTicket, assignees, reply, update, autoClose };
