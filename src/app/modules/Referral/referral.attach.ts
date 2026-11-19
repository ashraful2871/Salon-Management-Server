import { Prisma, ReferralChannel } from "@prisma/client";
import { Request } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { getSetting } from "../../utils/settings";
import { findReferrerByCode, type ReferrerHit } from "./referral.codes";
import { bdPhone, friendName, normalizeEmailForSelfCheck } from "./referral.math";
import { qualifyTx } from "./referral.lifecycle";
import { notifyJoined, notifyWelcome } from "./referral.notify";
import { signalsOf, signupFlags, type SignupSignals } from "./referral.risk";
import { loadReferralSettings } from "./referral.settings";

/**
 * Sign-up attach and email verification. A code attaches only inside the
 * transaction that creates the account (email register, Google `created`);
 * there is no later path. A refused code never creates a referral; soft risk
 * flags are saved on it and decide later whether the referrer's reward is held.
 */

export type AttachRefusal = "REFERRAL_PROGRAM_OFF" | "REFERRAL_CODE_INVALID" | "REFERRAL_SELF";

const REFUSALS: Record<AttachRefusal, string> = {
  REFERRAL_PROGRAM_OFF: "Invite codes are paused right now. Remove the code to create your account.",
  REFERRAL_CODE_INVALID: "That invite code isn't valid. Check it, or remove it to continue.",
  REFERRAL_SELF: "You can't use your own invite code.",
};

export type Precheck =
  | { ok: true; referrer: ReferrerHit }
  | { ok: false; code: AttachRefusal; message: string };

const refuse = (code: AttachRefusal): Precheck => ({ ok: false, code, message: REFUSALS[code] });

/** The 400 an email registration answers with, pointing the form at the code field. */
export const refusalError = (p: Extract<Precheck, { ok: false }>) =>
  ApiError.withCode(StatusCodes.BAD_REQUEST, p.message, p.code, { field: "referralCode" });

/**
 * Hard checks, run before the user transaction. Self covers the same user, the
 * same normalized email (Gmail dots and +tags) and the same `01XXXXXXXXX` phone.
 */
export const precheckSignupCode = async ({
  code,
  email,
  phone,
  userId,
}: {
  code: string;
  email: string;
  phone?: string | null;
  userId?: string | null;
}): Promise<Precheck> => {
  if (!(await getSetting("referral.enabled"))) return refuse("REFERRAL_PROGRAM_OFF");

  const referrer = await findReferrerByCode(code);
  if (!referrer) return refuse("REFERRAL_CODE_INVALID");

  const phoneOfReferee = bdPhone(phone);
  const self =
    (!!userId && referrer.userId === userId) ||
    normalizeEmailForSelfCheck(referrer.user.email) === normalizeEmailForSelfCheck(email) ||
    (!!phoneOfReferee && phoneOfReferee === bdPhone(referrer.user.phone));
  if (self) return refuse("REFERRAL_SELF");

  return { ok: true, referrer };
};

/**
 * What a controller hands the auth services: how the code arrived
 * (`X-Referral-Source: link` → LINK, else CODE) and the request's hashed
 * device/IP, worked out only if a code is actually attached.
 */
export type SignupReferralCtx = { channel: ReferralChannel; signals: () => SignupSignals };

export const signupCtxOf = (req: Request): SignupReferralCtx => ({
  channel: req.get("x-referral-source")?.trim().toLowerCase() === "link" ? "LINK" : "CODE",
  signals: signalsOf(req),
});

export type PreparedAttach = {
  referrer: ReferrerHit;
  channel: ReferralChannel;
  ipHash: string | null;
  deviceHash: string | null;
  flags: string[];
};

/** Hashes and soft flags, read before the user transaction (reads only). */
export const prepareAttach = async (
  referrer: ReferrerHit,
  refereeEmail: string,
  ctx?: SignupReferralCtx,
): Promise<PreparedAttach> => {
  const { ipHash, deviceHash } = ctx?.signals() ?? { ipHash: null, deviceHash: null };
  const flags = await signupFlags({ code: referrer, refereeEmail, ipHash, deviceHash });
  return { referrer, channel: ctx?.channel ?? "CODE", ipHash, deviceHash, flags };
};

export type AttachResult = { referralId: string; referrerId: string; joined: boolean; welcomeIssued: boolean };

/**
 * Inside the user-create transaction: the Referral row (JOINED when the new
 * account is already verified, else PENDING_VERIFICATION) and its `attached`
 * event; a JOINED one also gets its welcome reward here.
 */
export const attachOnSignupTx = async (
  tx: Prisma.TransactionClient,
  a: PreparedAttach & { refereeId: string; verified: boolean; isTest?: boolean },
): Promise<AttachResult> => {
  const now = new Date();
  const referral = await tx.referral.create({
    data: {
      referrerId: a.referrer.userId,
      refereeId: a.refereeId,
      code: a.referrer.code,
      channel: a.channel,
      status: a.verified ? "JOINED" : "PENDING_VERIFICATION",
      riskFlags: a.flags,
      refereeIpHash: a.ipHash,
      refereeDeviceHash: a.deviceHash,
      joinedAt: a.verified ? now : null,
      isTest: a.referrer.user.isTest || !!a.isTest,
    },
    select: { id: true },
  });
  await tx.referralEvent.create({
    data: { referralId: referral.id, type: "attached", data: { channel: a.channel, flags: a.flags } },
  });

  let welcomeIssued = false;
  if (a.verified) {
    await tx.referralEvent.create({ data: { referralId: referral.id, type: "verified" } });
    welcomeIssued = !!(await issueWelcomeTx(tx, a.refereeId))?.issued;
  }
  return { referralId: referral.id, referrerId: a.referrer.userId, joined: a.verified, welcomeIssued };
};

/**
 * The referee's welcome reward, once (`@@unique([referralId, kind])`; the
 * insert skips a duplicate, so a repeat never aborts the transaction). Terms
 * are snapshotted from today's settings. With `referrerTrigger =
 * REFEREE_VERIFIED` the referral also qualifies now. Issued for a referral
 * attached while the program was on even if it has been switched off since.
 */
export const issueWelcomeTx = async (tx: Prisma.TransactionClient, refereeId: string) => {
  const referral = await tx.referral.findUnique({
    where: { refereeId },
    select: { id: true, status: true },
  });
  if (!referral || (referral.status !== "JOINED" && referral.status !== "QUALIFIED")) return null;

  const s = await loadReferralSettings();
  const expiresAt = new Date(Date.now() + s.refereeValidDays * 24 * 60 * 60 * 1000);
  const { count } = await tx.referralReward.createMany({
    data: [
      {
        userId: refereeId,
        referralId: referral.id,
        kind: "REFEREE_WELCOME",
        status: "AVAILABLE",
        percentBps: s.refereePercentBps,
        maxDiscountMinor: s.refereeMaxDiscountMinor,
        minOrderMinor: s.minOrderMinor,
        scope: s.refereeScope,
        firstBookingOnly: true,
        expiresAt,
      },
    ],
    skipDuplicates: true,
  });
  const reward = await tx.referralReward.findUniqueOrThrow({
    where: { referralId_kind: { referralId: referral.id, kind: "REFEREE_WELCOME" } },
  });
  if (count === 0) return { reward, issued: false };

  await tx.referralEvent.create({
    data: {
      referralId: referral.id,
      rewardId: reward.id,
      type: "welcome.issued",
      data: {
        percentBps: reward.percentBps,
        maxDiscountMinor: reward.maxDiscountMinor,
        minOrderMinor: reward.minOrderMinor,
        scope: reward.scope,
        expiresAt: reward.expiresAt.toISOString(),
      },
    },
  });
  // No booking needed under this trigger (b = null).
  if (s.referrerTrigger === "REFEREE_VERIFIED") await qualifyTx(tx, refereeId, null);
  return { reward, issued: true };
};

/** After the attach/verify transaction commits: the welcome to the friend, "joined" to the referrer. */
export const notifyAfterJoin = async (r: { refereeId: string; refereeName: string; referrerId: string; referralId: string; welcomeIssued: boolean }) => {
  if (r.welcomeIssued) await notifyWelcome(r.refereeId);
  await notifyJoined(r.referrerId, friendName(r.refereeName), r.referralId);
};

/**
 * The referee's email is verified (OTP, Google, admin, or at sign-up when
 * verification is off): PENDING_VERIFICATION → JOINED and the welcome reward in
 * one transaction, then the notifications. Never throws into the auth flow.
 * Costs one indexed read for everyone without a pending referral.
 */
export const onEmailVerified = async (userId: string): Promise<void> => {
  try {
    const pending = await prisma.referral.findFirst({
      where: { refereeId: userId, status: "PENDING_VERIFICATION" },
      select: { id: true },
    });
    if (!pending) return;

    const done = await prisma.$transaction(async (tx) => {
      const moved = await tx.referral.updateMany({
        where: { id: pending.id, status: "PENDING_VERIFICATION" },
        data: { status: "JOINED", joinedAt: new Date() },
      });
      if (moved.count === 0) return null; // a parallel verification got here first
      const referral = await tx.referral.findUniqueOrThrow({
        where: { id: pending.id },
        select: { id: true, referrerId: true, referee: { select: { name: true } } },
      });
      await tx.referralEvent.create({ data: { referralId: referral.id, type: "verified" } });
      const welcome = await issueWelcomeTx(tx, userId);
      return { referral, welcomeIssued: !!welcome?.issued };
    });
    if (!done) return;

    await notifyAfterJoin({
      refereeId: userId,
      refereeName: done.referral.referee.name,
      referrerId: done.referral.referrerId,
      referralId: done.referral.id,
      welcomeIssued: done.welcomeIssued,
    });
  } catch (err) {
    console.error("[referral] onEmailVerified failed", err);
  }
};
