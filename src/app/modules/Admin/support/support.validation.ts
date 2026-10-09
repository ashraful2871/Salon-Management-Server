import { z } from "zod";

/** Shared with `components/Admin/support/labels.ts`. */
export const TICKET_CATEGORIES = ["BOOKING", "PAYMENT", "ACCOUNT", "SALON", "TECHNICAL", "OTHER"] as const;
export const TICKET_STATUSES = ["OPEN", "PENDING", "RESOLVED", "CLOSED"] as const;
export const TICKET_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

const list = z.object({
  query: z.object({
    status: z.enum(TICKET_STATUSES).optional(),
    // me | none | <admin user id>
    assignee: z.union([z.enum(["me", "none"]), z.string().uuid()]).optional(),
    category: z.enum(TICKET_CATEGORIES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    q: z.string().max(100).optional(),
    sort: z.string().max(40).optional(),
    page: z.string().optional(),
    limit: z.string().optional(),
  }),
});

const reply = z.object({
  body: z.object({
    body: z.string().trim().min(1, "Write a message").max(5000),
    internal: z.boolean().default(false),
  }),
});

const update = z.object({
  body: z
    .object({
      status: z.enum(TICKET_STATUSES).optional(),
      assigneeId: z.string().uuid().nullable().optional(),
      priority: z.enum(TICKET_PRIORITIES).optional(),
      category: z.enum(TICKET_CATEGORIES).optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Nothing to change" }),
});

export type TicketReply = z.infer<typeof reply>["body"];
export type TicketUpdate = z.infer<typeof update>["body"];

export const AdminSupportValidation = { list, reply, update };
