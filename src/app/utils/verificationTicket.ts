import jwt, { JwtPayload } from "jsonwebtoken";
import ApiError from "../Error/error";
import { authKey } from "./authKeys";

const AUDIENCE = "salon:email-verify";

/**
 * The short-lived proof, handed out after a correct password (or a Google
 * round trip), that lets its bearer ask for and enter a code for one account,
 * and nothing else. Its own key and audience keep it from passing as a session
 * token. `sv` pins it to the account's sessionVersion, so bumping that revokes it.
 */
export const createTicket = ({
  userId,
  sessionVersion,
}: {
  userId: string;
  sessionVersion: number;
}) =>
  jwt.sign({ sv: sessionVersion }, authKey("ticket"), {
    subject: userId,
    audience: AUDIENCE,
    expiresIn: "30m",
    algorithm: "HS256",
  });

/**
 * Every failure reads as expired. jsonwebtoken's own errors must not escape:
 * the global handler would turn a TokenExpiredError into a 401 "session
 * expired", which is the wrong message and the wrong status for this screen.
 */
export const readTicket = (t: string) => {
  // Outside the try: a missing AUTH_OTP_SECRET is a 500, not an expired ticket.
  const key = authKey("ticket");

  try {
    const p = jwt.verify(t, key, {
      audience: AUDIENCE,
      algorithms: ["HS256"],
    }) as JwtPayload;

    if (!p.sub) throw new Error("ticket without subject");

    return { userId: String(p.sub), sv: Number(p.sv ?? 0) };
  } catch {
    throw ApiError.withCode(
      400,
      "Your verification session has expired. Please sign in again.",
      "TICKET_EXPIRED"
    );
  }
};

const TWO_FACTOR_AUDIENCE = "salon:2fa";
export const TWO_FACTOR_TICKET_SECONDS = 5 * 60;

/**
 * The proof, handed out after a correct password or Google round trip for an
 * ADMIN/AGENT with 2FA on, that lets its bearer enter one authenticator code.
 * Five minutes, its own audience, and single use: `ls` pins the account's
 * lastUsedStep, which every accepted code or recovery code moves on.
 */
export const createTwoFactorTicket = ({
  userId,
  sessionVersion,
  lastUsedStep,
}: {
  userId: string;
  sessionVersion: number;
  lastUsedStep: number | null;
}) =>
  jwt.sign({ sv: sessionVersion, ls: lastUsedStep }, authKey("ticket"), {
    subject: userId,
    audience: TWO_FACTOR_AUDIENCE,
    expiresIn: TWO_FACTOR_TICKET_SECONDS,
    algorithm: "HS256",
  });

export const readTwoFactorTicket = (t: string) => {
  const key = authKey("ticket");

  try {
    const p = jwt.verify(t, key, {
      audience: TWO_FACTOR_AUDIENCE,
      algorithms: ["HS256"],
    }) as JwtPayload;

    if (!p.sub) throw new Error("ticket without subject");

    return {
      userId: String(p.sub),
      sv: Number(p.sv ?? 0),
      ls: p.ls === null || p.ls === undefined ? null : Number(p.ls),
    };
  } catch {
    throw ApiError.withCode(
      400,
      "Your sign-in has expired. Please sign in again.",
      "TICKET_EXPIRED"
    );
  }
};
