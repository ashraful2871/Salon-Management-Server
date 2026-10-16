import { z } from "zod";
import { BranchRole } from "@prisma/client";

const email = z.string().trim().toLowerCase().email("Enter a valid email address");
const name = z.string().trim().min(1).max(100).optional();
const token = z.string().trim().min(20).max(200);
const id = z.string().uuid();

const invite = z.object({
  params: z.object({ salonId: id }),
  body: z.object({ email, name, role: z.nativeEnum(BranchRole) }),
});

const updateMember = z.object({
  params: z.object({ salonId: id, memberId: id }),
  body: z
    .object({
      role: z.nativeEnum(BranchRole).optional(),
      status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
    })
    .refine((body) => body.role !== undefined || body.status !== undefined, {
      message: "Send a role or a status",
    }),
});

const preview = z.object({ query: z.object({ token }) });

const accept = z.object({ body: z.object({ token }) });

export const TeamValidation = {
  invite,
  updateMember,
  preview,
  accept,
};
