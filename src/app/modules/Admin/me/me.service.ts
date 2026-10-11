import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { audit, AuditCtx } from "../../../utils/audit";
import {
  encrypt,
  formatManualKey,
  generateRecoveryCodes,
  newTotpSecret,
  openStepUp,
  otpauthUrl,
  qrDataUrl,
  verifyCode,
} from "../../../utils/mfa";

const alreadyOn = () =>
  ApiError.withCode(
    StatusCodes.CONFLICT,
    "Two-factor sign-in is already on for this account.",
    "TWO_FACTOR_ALREADY_ENABLED",
  );

/**
 * Starts (or restarts) enrolment: a fresh secret replaces any pending one.
 * The secret is returned once, here, and never again.
 */
const setup = async (userId: string) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, mfa: { select: { enabledAt: true } } },
  });
  if (user.mfa?.enabledAt) throw alreadyOn();

  const secret = newTotpSecret();
  const pending = {
    secretEnc: encrypt(secret),
    enabledAt: null,
    lastUsedStep: null,
    recoveryCodeHashes: [],
    failedAttempts: 0,
    lockedUntil: null,
    stepUpUntil: null,
  };
  await prisma.userMfa.upsert({
    where: { userId },
    create: { userId, ...pending },
    update: pending,
  });

  const url = otpauthUrl(user.email, secret);
  return {
    otpauthUrl: url,
    qrDataUrl: await qrDataUrl(url),
    manualKey: formatManualKey(secret),
  };
};

/** First correct code turns 2FA on and hands out the recovery codes once. */
const activate = async (userId: string, code: string, ctx?: AuditCtx) => {
  const row = await prisma.userMfa.findUnique({
    where: { userId },
    select: { enabledAt: true },
  });
  if (row?.enabledAt) throw alreadyOn();

  await verifyCode(userId, code, { requireEnabled: false });

  const { codes, hashes } = generateRecoveryCodes();
  const enabledAt = new Date();
  // Conditional, so two racing activations cannot hand out two sets of codes.
  const claimed = await prisma.userMfa.updateMany({
    where: { userId, enabledAt: null },
    data: { enabledAt, recoveryCodeHashes: hashes },
  });
  if (claimed.count === 0) throw alreadyOn();

  // The code was just confirmed, so the step-up window opens too.
  const stepUpUntil = await openStepUp(userId);

  await audit(ctx, {
    action: "mfa.enable",
    entityType: "user",
    entityId: userId,
    after: { enabledAt },
  });

  return { recoveryCodes: codes, stepUpUntil };
};

const stepUp = async (userId: string, code: string, ctx?: AuditCtx) => {
  await verifyCode(userId, code);
  const stepUpUntil = await openStepUp(userId);
  await audit(ctx, {
    action: "mfa.step_up",
    entityType: "user",
    entityId: userId,
    after: { stepUpUntil },
  });
  return { stepUpUntil };
};

/** Tier 3 (behind requireStepUp): every older recovery code stops working. */
const regenerateRecoveryCodes = async (userId: string, ctx?: AuditCtx) => {
  const { codes, hashes } = generateRecoveryCodes();
  const updated = await prisma.userMfa.updateMany({
    where: { userId, enabledAt: { not: null } },
    data: { recoveryCodeHashes: hashes },
  });
  if (updated.count === 0) {
    throw ApiError.withCode(
      StatusCodes.FORBIDDEN,
      "Set up two-factor sign-in first.",
      "TWO_FACTOR_SETUP_REQUIRED",
    );
  }

  await audit(ctx, {
    action: "mfa.recovery_codes_regenerate",
    entityType: "user",
    entityId: userId,
  });

  return { recoveryCodes: codes };
};

export const AdminMeService = {
  setup,
  activate,
  stepUp,
  regenerateRecoveryCodes,
};
