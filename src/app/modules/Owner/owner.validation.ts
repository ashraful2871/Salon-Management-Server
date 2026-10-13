import { z } from "zod";

/** `?salonId=` on owner pages: one branch, or every branch when absent. */
const branchQuery = z.object({
  query: z.object({
    salonId: z.string().trim().min(1).optional(),
  }),
});

const sixDigits = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code");
const accountName = z.string().trim().min(2, "Enter the account holder's name").max(120);
const wallet = z.string().trim().regex(/^01[3-9]\d{8}$/, "Enter an 11-digit number starting 01");

/** Per type: a wallet number for bKash/Nagad, bank + routing + number for BANK. */
const payoutAccountBody = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["BKASH", "NAGAD"]),
    accountName,
    walletNumber: wallet,
    code: sixDigits,
    totp: sixDigits.optional(),
  }),
  z.object({
    type: z.literal("BANK"),
    accountName,
    bankName: z.string().trim().min(2, "Enter the bank name").max(120),
    branchName: z.string().trim().min(2, "Enter the branch").max(120),
    routingNumber: z.string().trim().regex(/^\d{9}$/, "The routing number is 9 digits"),
    accountNumber: z.string().trim().regex(/^\d{6,20}$/, "The account number is 6 to 20 digits"),
    code: sixDigits,
    totp: sixDigits.optional(),
  }),
]);

const addPayoutAccount = z.object({ body: payoutAccountBody });

const kycBody = z.object({
  legalName: z.string().trim().min(2, "Enter the business's legal name").max(160),
  tradeLicenseNo: z.string().trim().min(3, "Enter the trade licence number").max(60),
  tin: z
    .string()
    .trim()
    .regex(/^\d{12}$/, "The TIN is 12 digits")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  bin: z
    .string()
    .trim()
    .regex(/^\d{9,13}$/, "The BIN is 9 to 13 digits")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  nidLast4: z.string().trim().regex(/^\d{4}$/, "Enter the last 4 digits of the NID"),
});

const updateKyc = z.object({ body: kycBody });

export type AddPayoutAccountInput = z.infer<typeof payoutAccountBody>;
export type KycInput = z.infer<typeof kycBody>;

export const OwnerValidation = {
  branchQuery,
  addPayoutAccount,
  updateKyc,
};
