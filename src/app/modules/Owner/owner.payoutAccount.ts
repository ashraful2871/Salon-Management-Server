import { Request, Response } from "express";
import { KycStatus, PayoutAccount, PayoutAccountStatus, PayoutAccountType, Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import { auditTx, audit, diff } from "../../utils/audit";
import { sendEmail } from "../../utils/emailSender";
import { notifyOwner } from "../../utils/notify";
import { getOtpEmailTemplate, getPayoutAccountAddedTemplate } from "../../utils/emailTemplates";
import { decryptField, encryptField } from "../../utils/fieldCrypto";
import { enabledMfaStep, verifyCode } from "../../utils/mfa";
import { issueOtp, maskEmail, OTP_TTL_SECONDS, verifyOtp, OtpFailure } from "../../utils/otp";
import { assertOwnerOf, withAccessCache } from "../../utils/salonAccess";
import { getSetting } from "../../utils/settings";
import { clientIp } from "../../middlewares/rateLimiter";
import { buildAuditCtx } from "../Admin/admin.middleware";
import { AddPayoutAccountInput, KycInput } from "./owner.validation";

/**
 * Where a business is paid. An owner adds an account with a code emailed to
 * their sign-in address (and their authenticator code when 2FA is on); Finance
 * then verifies it. Full bank numbers are encrypted and never leave the API
 * from here - owners only ever see the masked form.
 */

// ---------------------------------------------------------------- masking

const TYPE_LABEL: Record<PayoutAccountType, string> = {
  BKASH: "bKash",
  NAGAD: "Nagad",
  BANK: "Bank",
};

/** "01712345678" -> "01•••••5678"; bank numbers -> "•••• 5678". */
export const maskedNumber = (row: Pick<PayoutAccount, "type" | "walletNumber" | "last4">) =>
  row.type !== "BANK" && row.walletNumber
    ? `${row.walletNumber.slice(0, 2)}${"•".repeat(Math.max(1, row.walletNumber.length - 6))}${row.walletNumber.slice(-4)}`
    : `•••• ${row.last4}`;

/** One line for emails and audit: "bKash 01•••••5678", "City Bank •••• 5678". */
export const describeAccount = (
  row: Pick<PayoutAccount, "type" | "walletNumber" | "last4" | "bankName">,
) => `${row.type === "BANK" ? row.bankName || "Bank" : TYPE_LABEL[row.type]} ${maskedNumber(row)}`;

/** What an owner (or a Finance list without PII) may see of an account. */
export const maskAccount = (row: PayoutAccount) => ({
  id: row.id,
  type: row.type,
  accountName: row.accountName,
  number: maskedNumber(row),
  last4: row.last4,
  bankName: row.bankName,
  branchName: row.branchName,
  routingNumber: row.routingNumber,
  status: row.status,
  cooldownUntil: row.cooldownUntil,
  rejectionReason: row.rejectionReason,
  verifiedAt: row.verifiedAt,
  createdAt: row.createdAt,
});

/** The full number, for Finance with users.view_pii only (audited by the caller). */
export const revealNumber = (row: PayoutAccount) =>
  row.type === "BANK"
    ? row.accountNumberEnc
      ? decryptField(row.accountNumberEnc)
      : null
    : row.walletNumber;

// ---------------------------------------------------------------- helpers

const OTP_ERRORS: Record<OtpFailure, { message: string; errorCode: string }> = {
  INVALID: { message: "That code isn't right.", errorCode: "OTP_INVALID" },
  EXPIRED: { message: "This code has expired. Request a new one.", errorCode: "OTP_EXPIRED" },
  LOCKED: { message: "Too many wrong attempts. Request a new code.", errorCode: "OTP_LOCKED" },
  NONE: { message: "No active code. Request a new one.", errorCode: "OTP_NONE" },
};

const ownerProfile = async (req: Request) => {
  const { ownerId } = await assertOwnerOf(withAccessCache(req));
  return prisma.salonOwner.findUniqueOrThrow({
    where: { id: ownerId },
    select: {
      id: true,
      businessEmail: true,
      legalName: true,
      tradeLicenseNo: true,
      tin: true,
      bin: true,
      nidLast4: true,
      kycStatus: true,
      kycNote: true,
      payoutsFrozen: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });
};

const ok = (res: Response, message: string, data: unknown, statusCode = StatusCodes.OK) =>
  sendResponse(res, { statusCode, success: true, message, data });

// ---------------------------------------------------------------- endpoints

/** GET /owner/payout-accounts - every live account, masked, plus KYC. */
const list = catchAsync(async (req: Request, res: Response) => {
  const owner = await ownerProfile(req);
  const [accounts, mfa, cooldownHours] = await Promise.all([
    prisma.payoutAccount.findMany({
      where: { ownerId: owner.id, status: { not: PayoutAccountStatus.DISABLED } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    enabledMfaStep(owner.user.id),
    getSetting("payouts.accountCooldownHours"),
  ]);

  // Only the newest rejection matters to the owner; older ones are history.
  const firstRejected = accounts.findIndex((a) => a.status === PayoutAccountStatus.REJECTED);
  const visible = accounts.filter(
    (a, i) => a.status !== PayoutAccountStatus.REJECTED || i === firstRejected,
  );

  ok(res, "Payout accounts", {
    accounts: visible.map(maskAccount),
    codeEmail: maskEmail(owner.user.email),
    totpRequired: !!mfa,
    cooldownHours,
    payoutsFrozen: owner.payoutsFrozen,
    kyc: {
      legalName: owner.legalName,
      tradeLicenseNo: owner.tradeLicenseNo,
      tin: owner.tin,
      bin: owner.bin,
      nidLast4: owner.nidLast4,
      status: owner.kycStatus,
      note: owner.kycNote,
    },
  });
});

/** POST /owner/payout-accounts/code - emails a 6-digit code to the owner. */
const sendCode = catchAsync(async (req: Request, res: Response) => {
  const owner = await ownerProfile(req);
  const issued = await issueOtp({
    userId: owner.user.id,
    purpose: "PAYOUT_ACCOUNT",
    target: owner.user.email,
    ip: clientIp(req),
  });

  if (!issued.ok) {
    throw ApiError.withCode(
      StatusCodes.TOO_MANY_REQUESTS,
      "Please wait before requesting another code",
      "OTP_THROTTLED",
      { retryAfter: issued.retryAfter },
    );
  }

  await sendEmail(
    owner.user.email,
    `${issued.code} is your SalonKhuji code to change your payout account`,
    getOtpEmailTemplate(owner.user.name, issued.code, OTP_TTL_SECONDS / 60),
  );

  ok(res, "Code sent", { maskedEmail: maskEmail(owner.user.email), expiresIn: OTP_TTL_SECONDS });
});

/** Same destination as an account already on file (compared in the clear). */
const sameDestination = (row: PayoutAccount, input: AddPayoutAccountInput) => {
  if (row.type !== input.type) return false;
  if (input.type !== "BANK") return row.walletNumber === input.walletNumber;
  if (row.routingNumber !== input.routingNumber || row.last4 !== input.accountNumber.slice(-4)) {
    return false;
  }
  return revealNumber(row) === input.accountNumber;
};

/** POST /owner/payout-accounts - adds a PENDING_VERIFICATION account. */
const add = catchAsync(async (req: Request, res: Response) => {
  const owner = await ownerProfile(req);
  const input = req.body as AddPayoutAccountInput;

  // The authenticator first: a failed TOTP must not burn the emailed code.
  if (await enabledMfaStep(owner.user.id)) {
    if (!input.totp) {
      throw ApiError.withCode(
        StatusCodes.BAD_REQUEST,
        "Enter the 6-digit code from your authenticator app",
        "TOTP_REQUIRED",
      );
    }
    await verifyCode(owner.user.id, input.totp);
  }

  const checked = await verifyOtp({
    userId: owner.user.id,
    purpose: "PAYOUT_ACCOUNT",
    code: input.code,
    target: owner.user.email,
  });
  if (!checked.ok) {
    const { message, errorCode } = OTP_ERRORS[checked.reason];
    throw ApiError.withCode(
      StatusCodes.BAD_REQUEST,
      message,
      errorCode,
      checked.reason === "INVALID" ? { attemptsLeft: checked.attemptsLeft } : undefined,
    );
  }

  const live = await prisma.payoutAccount.findMany({
    where: {
      ownerId: owner.id,
      status: { in: [PayoutAccountStatus.VERIFIED, PayoutAccountStatus.PENDING_VERIFICATION] },
    },
  });
  const verified = live.filter((a) => a.status === PayoutAccountStatus.VERIFIED);
  const pending = live.filter((a) => a.status === PayoutAccountStatus.PENDING_VERIFICATION);

  if (verified.some((a) => sameDestination(a, input))) {
    throw new ApiError(StatusCodes.CONFLICT, "This account is already your verified payout account");
  }

  const data: Prisma.PayoutAccountUncheckedCreateInput =
    input.type === "BANK"
      ? {
          ownerId: owner.id,
          type: input.type,
          accountName: input.accountName,
          bankName: input.bankName,
          branchName: input.branchName,
          routingNumber: input.routingNumber,
          accountNumberEnc: encryptField(input.accountNumber),
          last4: input.accountNumber.slice(-4),
        }
      : {
          ownerId: owner.id,
          type: input.type,
          accountName: input.accountName,
          walletNumber: input.walletNumber,
          last4: input.walletNumber.slice(-4),
        };

  const cooldownHours = await getSetting("payouts.accountCooldownHours");
  // A first account has nothing to protect; a change waits out the cooldown.
  if (verified.length > 0 && cooldownHours > 0) {
    data.cooldownUntil = new Date(Date.now() + cooldownHours * 60 * 60 * 1000);
  }

  const ctx = buildAuditCtx(req, "SALON_OWNER");
  const created = await prisma.$transaction(async (tx) => {
    // One pending account at a time: the newest replaces the older one.
    if (pending.length > 0) {
      await tx.payoutAccount.updateMany({
        where: { id: { in: pending.map((a) => a.id) }, status: PayoutAccountStatus.PENDING_VERIFICATION },
        data: { status: PayoutAccountStatus.DISABLED, rejectionReason: "Replaced by a newer account" },
      });
    }
    const row = await tx.payoutAccount.create({ data });
    await auditTx(tx, ctx, {
      action: "payout_account.add",
      entityType: "payout_account",
      entityId: row.id,
      after: {
        ownerId: owner.id,
        type: row.type,
        accountName: row.accountName,
        account: describeAccount(row),
        cooldownUntil: row.cooldownUntil,
        replacedPending: pending.map((a) => a.id),
      },
    });
    return row;
  });

  const notice = getPayoutAccountAddedTemplate({
    ownerName: owner.user.name,
    account: describeAccount(created),
    cooldownHours: created.cooldownUntil ? cooldownHours : null,
    contactUrl: `${config.frontend_url}/contact`,
  });
  const subject = "A payout account was added to your SalonKhuji business";
  // The owner through notify (email locked on); the business email, when it is
  // a different address, still gets its own copy - it is the security notice.
  await notifyOwner(owner.id, "payout_account.changed", {
    title: subject,
    body: `${describeAccount(created)} was added and waits for verification. Not you? Contact support now.`,
    link: "/dashboard/money/payout-settings",
    dedupeKey: `payout_account.changed:${created.id}`,
    email: { subject, html: notice },
  });
  const businessEmail = owner.businessEmail?.trim().toLowerCase();
  if (businessEmail && businessEmail !== owner.user.email.trim().toLowerCase()) {
    await sendEmail(businessEmail, subject, notice);
  }

  ok(res, "Account added. Our finance team will verify it shortly.", maskAccount(created), StatusCodes.CREATED);
});

/** PATCH /owner/kyc - business identity for Finance to verify. */
const updateKyc = catchAsync(async (req: Request, res: Response) => {
  const owner = await ownerProfile(req);
  const input = req.body as KycInput;

  const before = {
    legalName: owner.legalName,
    tradeLicenseNo: owner.tradeLicenseNo,
    tin: owner.tin,
    bin: owner.bin,
    nidLast4: owner.nidLast4,
    kycStatus: owner.kycStatus,
  };
  const after = {
    legalName: input.legalName,
    tradeLicenseNo: input.tradeLicenseNo,
    tin: input.tin ?? null,
    bin: input.bin ?? null,
    nidLast4: input.nidLast4,
    kycStatus: KycStatus.SUBMITTED,
  };

  await prisma.salonOwner.update({
    where: { id: owner.id },
    data: { ...after, kycNote: null },
  });
  await audit(buildAuditCtx(req, "SALON_OWNER"), {
    action: "owner.kyc_submit",
    entityType: "salon_owner",
    entityId: owner.id,
    ...diff(before, after),
  });

  ok(res, "Business details submitted for verification", { ...after, status: after.kycStatus, note: null });
});

export const OwnerPayoutAccount = { list, sendCode, add, updateKyc };
