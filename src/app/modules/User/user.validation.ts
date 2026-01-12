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
  }),
});

const updateUserRoleValidation = z.object({
  body: z.object({
    role: z.enum(["CUSTOMER", "STAFF", "SALON_OWNER", "ADMIN"]),
  }),
});

export const UserValidation = {
  updateUserValidation,
  updateUserStatusValidation,
  updateUserRoleValidation,
};
