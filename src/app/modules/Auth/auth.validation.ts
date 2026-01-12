import { z } from "zod";

const registerValidation = z.object({
  body: z.object({
    email: z
      .string()
      .nonempty({ message: "Email is required" })
      .email("Invalid email format"),
    password: z
      .string()
      .nonempty({ message: "Password is required" })
      .min(6, "Password must be at least 6 characters"),
    name: z.string().nonempty({ message: "Name is required" }),
    phone: z.string().optional(),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
    dateOfBirth: z.string().optional(),
    address: z.string().optional(),
    role: z.enum(["CUSTOMER", "SALON_OWNER"]).optional(),
  }),
});

const loginValidation = z.object({
  body: z.object({
    email: z
      .string()
      .nonempty({ message: "Email is required" })
      .email("Invalid email format"),
    password: z.string().nonempty({ message: "Password is required" }),
  }),
});

const changePasswordValidation = z.object({
  body: z.object({
    oldPassword: z.string().nonempty({ message: "Old password is required" }),
    newPassword: z
      .string()
      .nonempty({ message: "New password is required" })
      .min(6, "Password must be at least 6 characters"),
  }),
});

const refreshTokenValidation = z.object({
  body: z.object({
    refreshToken: z.string().nonempty({ message: "Refresh token is required" }),
  }),
});

export const AuthValidation = {
  registerValidation,
  loginValidation,
  changePasswordValidation,
  refreshTokenValidation,
};
