import { z } from "zod";

const sendContact = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().email().max(120),
    subject: z.string().trim().max(120).optional(),
    message: z.string().trim().min(10).max(2000),
    // Honeypot: the form hides this field, so only a bot fills it in.
    company: z.string().max(0).optional(),
  }),
});

export type ContactMessage = z.infer<typeof sendContact>["body"];

export const ContactValidation = {
  sendContact,
};
