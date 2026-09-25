import { z } from "zod";

/** Trimmed and lower-cased, so every lookup and write sees one spelling. */
const email = (required = "Email is required") =>
  z
    .string()
    .trim()
    .toLowerCase()
    .nonempty({ message: required })
    .email("Invalid email format");

/** For new passwords only. Login has no minimum, so old 6-character passwords still sign in. */
const newPassword = (required: string) =>
  z
    .string()
    .nonempty({ message: required })
    .min(8, "Password must be at least 8 characters");

/**
 * A Bangladeshi mobile number, format only (the number is not verified).
 * Spaces and dashes are stripped first; an empty string counts as absent.
 */
const bdPhone = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const s = v.replace(/[\s-]/g, "");
    return s === "" ? undefined : s;
  },
  z
    .string()
    .regex(/^(?:\+?88)?01[3-9]\d{8}$/, "Enter a valid Bangladeshi mobile number")
    .optional(),
);

/** A verification ticket: long enough that a stray short string is rejected early. */
const ticket = z.string().min(20);

const registerValidation = z.object({
  body: z.object({
    email: email(),
    password: newPassword("Password is required"),
    name: z.string().nonempty({ message: "Name is required" }),
    phone: bdPhone,
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
    dateOfBirth: z.string().optional(),
    address: z.string().optional(),
    role: z.enum(["CUSTOMER", "SALON_OWNER"]).optional(),
  }),
});

const loginValidation = z.object({
  body: z.object({
    email: email(),
    password: z.string().nonempty({ message: "Password is required" }),
  }),
});

const verifyOtpValidation = z.object({
  body: z.object({
    ticket,
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
  }),
});

const resendOtpValidation = z.object({
  body: z.object({
    ticket,
  }),
});

const changePasswordValidation = z.object({
  body: z.object({
    oldPassword: z.string().nonempty({ message: "Old password is required" }),
    newPassword: newPassword("New password is required"),
  }),
});

const changeEmailValidation = z.object({
  body: z.object({
    newEmail: email("New email is required"),
    // Required by the service when the account has a password; Google-only
    // accounts have none to give.
    password: z.string().optional(),
  }),
});

const confirmEmailChangeValidation = z.object({
  body: z.object({
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
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
    email: email(),
  }),
});

const resetPasswordValidation = z.object({
  body: z.object({
    token: z.string().nonempty({ message: 'Reset token is required' }),
    newPassword: newPassword('New password is required'),
  }),
});

const googleStartValidation = z.object({
  body: z.object({
    redirect: z.string().max(300).optional(),
  }),
});

const googleCallbackValidation = z.object({
  body: z.object({
    code: z.string().min(1).max(2048),
    state: z.string().max(200),
    flowToken: z.string().max(4096),
  }),
});

export const AuthValidation = {
  registerValidation,
  loginValidation,
  verifyOtpValidation,
  resendOtpValidation,
  changePasswordValidation,
  changeEmailValidation,
  confirmEmailChangeValidation,
  refreshTokenValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  googleStartValidation,
  googleCallbackValidation,
};
