import { z } from "zod";
import { AdminRole } from "@prisma/client";

const email = z.string().trim().toLowerCase().email("Enter a valid email address");
const name = z.string().trim().min(1).max(100).optional();
const token = z.string().trim().min(20).max(200);
const place = z.string().trim().min(1).max(100);

const inviteAdmin = z.object({
  body: z.object({ email, name, adminRole: z.nativeEnum(AdminRole) }),
});

const inviteAgent = z.object({
  body: z.object({ email, name, division: place, district: place, area: place }),
});

const preview = z.object({ query: z.object({ token }) });

const accept = z.object({ body: z.object({ token }) });

export const InvitationValidation = {
  inviteAdmin,
  inviteAgent,
  preview,
  accept,
};
