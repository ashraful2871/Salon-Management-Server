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

const changeEmailValidation = z.object({
  body: z.object({
    newEmail: z
      .string()
      .trim()
      .nonempty({ message: "New email is required" })
      .email("Invalid email format"),
    password: z.string().nonempty({ message: "Current password is required" }),
  }),
});

/**
 * Optional, because the token is just as likely to arrive in the `refreshToken`
 * cookie as in the body. Requiring it here rejected every browser-only refresh
 * with a 400 before the controller ever looked at the cookie; the controller
 * now answers 401 when neither source has one.
 */
const refreshTokenValidation = z.object({
  body: z
    .object({
      refreshToken: z.string().optional(),
    })
    .optional(),
});

const forgotPasswordValidation = z.object({
  body: z.object({
    email: z
      .string()
      .nonempty({ message: 'Email is required' })
      .email('Invalid email format'),
  }),
});

const resetPasswordValidation = z.object({
  body: z.object({
    token: z.string().nonempty({ message: 'Reset token is required' }),
    newPassword: z
      .string()
      .nonempty({ message: 'New password is required' })
      .min(6, 'Password must be at least 6 characters'),
  }),
});

const verifyEmailValidation = z.object({
  body: z.object({
    token: z.string().nonempty({ message: 'Verification token is required' }),
  }),
});

const resendVerificationValidation = z.object({
  body: z.object({
    email: z
      .string()
      .nonempty({ message: 'Email is required' })
      .email('Invalid email format'),
  }),
});

export const AuthValidation = {
  registerValidation,
  loginValidation,
  changePasswordValidation,
  changeEmailValidation,
  refreshTokenValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  verifyEmailValidation,
  resendVerificationValidation,
};
