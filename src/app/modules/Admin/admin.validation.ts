import { z } from "zod";

export const NOTE_ENTITY_TYPES = [
  "user",
  "salon",
  "booking",
  "payout",
  "intent",
  "wallet",
] as const;

const listNotes = z.object({
  query: z.object({
    entityType: z.enum(NOTE_ENTITY_TYPES),
    entityId: z.string().trim().min(1).max(100),
  }),
});

const createNote = z.object({
  body: z.object({
    entityType: z.enum(NOTE_ENTITY_TYPES),
    entityId: z.string().trim().min(1).max(100),
    body: z.string().trim().min(1).max(2000),
    pinned: z.boolean().optional(),
  }),
});

const search = z.object({
  query: z.object({
    q: z.string().trim().min(1).max(100),
  }),
});

const updateMe = z.object({
  body: z.object({ alertEmails: z.boolean() }).strict(),
});

export const AdminValidation = {
  updateMe,
  listNotes,
  createNote,
  search,
};
