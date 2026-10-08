import { z } from "zod";

const updateUserValidation = z.object({
  body: z.object({
    name: z.string().optional(),
    phone: z.string().optional(),
    profilePhoto: z.string().optional(),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
    dateOfBirth: z.string().optional(),
    address: z.string().optional(),
  }),
});

const updateUserStatusValidation = z.object({
  body: z.object({
    status: z.enum(["ACTIVE", "INACTIVE", "SUSPENDED", "BLOCKED"]),
    reason: z.string().trim().max(500).optional(),
  }),
});

const updateUserRoleValidation = z.object({
  body: z.object({
    // ADMIN is deliberately absent: admins are created from the admin team
    // page (or `npm run admin:create`), never promoted through this endpoint.
    role: z.enum(["CUSTOMER", "STAFF", "SALON_OWNER"]),
    reason: z.string().trim().max(500).optional(),
  }),
});

export const UserValidation = {
  updateUserValidation,
  updateUserStatusValidation,
  updateUserRoleValidation,
};
