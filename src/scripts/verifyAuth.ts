/**
 * Offline checks for the auth building blocks: no database, no network.
 *
 *   npm run verify:auth
 *
 * AUTH_OTP_SECRET is replaced with a throwaway value before config loads, so
 * the real one is never read or printed. Exits 1 on any FAIL.
 */
import { randomBytes } from "crypto";

process.env.AUTH_OTP_SECRET = randomBytes(32).toString("hex");
// Only so the JWT_SECRET checks mean something on a machine without a .env.
process.env.JWT_SECRET ||= randomBytes(32).toString("hex");

let failed = 0;

const check = (name: string, fn: () => boolean) => {
  let ok = false;
  try {
    ok = fn();
  } catch {
    ok = false;
  }
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
};

const throwsCode = (fn: () => unknown, code: string) => {
  try {
    fn();
    return false;
  } catch (e) {
    return (e as { errorCode?: string }).errorCode === code;
  }
};

const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const main = async () => {
  // Imported only now, so config sees the throwaway secret.
  const jwt = (await import("jsonwebtoken")).default;
  const config = (await import("../config")).default;
  const { default: ApiError } = await import("../app/Error/error");
  const { jwtHelpers } = await import("../app/helper/jwtHelper");
  const { authKey } = await import("../app/utils/authKeys");
  const { maskEmail } = await import("../app/utils/otp");
  const { createTicket, readTicket } = await import("../app/utils/verificationTicket");

  check('maskEmail("ab@x.com") = "a*@x.com"', () => maskEmail("ab@x.com") === "a*@x.com");
  check(
    'maskEmail("ashraful@gmail.com") = "as******@gmail.com"',
    () => maskEmail("ashraful@gmail.com") === "as******@gmail.com"
  );
  check('maskEmail("a@x.com") = "a*@x.com"', () => maskEmail("a@x.com") === "a*@x.com");

  check("ticket round-trips { u1, 2 }", () => {
    const r = readTicket(createTicket({ userId: "u1", sessionVersion: 2 }));
    return r.userId === "u1" && r.sv === 2;
  });

  check("ticket signed with JWT_SECRET -> TICKET_EXPIRED", () =>
    throwsCode(
      () =>
        readTicket(
          jwt.sign({ sv: 0 }, config.jwt.jwt_secret, {
            subject: "u1",
            audience: "salon:email-verify",
            expiresIn: "30m",
            algorithm: "HS256",
          })
        ),
      "TICKET_EXPIRED"
    )
  );

  check("ticket signed with a random key -> TICKET_EXPIRED", () =>
    throwsCode(
      () =>
        readTicket(
          jwt.sign({ sv: 0 }, randomBytes(32), {
            subject: "u1",
            audience: "salon:email-verify",
            expiresIn: "30m",
            algorithm: "HS256",
          })
        ),
      "TICKET_EXPIRED"
    )
  );

  check("expired ticket -> TICKET_EXPIRED (not a 401 TokenExpiredError)", () =>
    throwsCode(
      () =>
        readTicket(
          jwt.sign({ sv: 0, exp: Math.floor(Date.now() / 1000) - 10 }, authKey("ticket"), {
            subject: "u1",
            audience: "salon:email-verify",
            algorithm: "HS256",
          })
        ),
      "TICKET_EXPIRED"
    )
  );

  check("access token from jwtHelpers.createToken -> readTicket rejects", () =>
    throwsCode(
      () =>
        readTicket(
          jwtHelpers.createToken(
            { userId: "u1", email: "u1@x.com", role: "CUSTOMER" },
            config.jwt.jwt_secret,
            "1h"
          )
        ),
      "TICKET_EXPIRED"
    )
  );

  check("ticket -> jwtHelpers.verifyToken(JWT_SECRET) throws", () =>
    throws(() =>
      jwtHelpers.verifyToken(
        createTicket({ userId: "u1", sessionVersion: 0 }),
        config.jwt.jwt_secret
      )
    )
  );

  check('authKey("otp") != authKey("ticket") != authKey("oauth-flow")', () => {
    const [a, b, c] = [authKey("otp"), authKey("ticket"), authKey("oauth-flow")];
    return !a.equals(b) && !b.equals(c) && !a.equals(c);
  });

  check("no derived key equals JWT_SECRET", () =>
    (["otp", "ticket", "oauth-flow"] as const).every(
      (p) => !authKey(p).equals(Buffer.from(config.jwt.jwt_secret))
    )
  );

  check('ApiError.withCode(400,"m","X",{a:1}) carries errorCode and details', () => {
    const e = ApiError.withCode(400, "m", "X", { a: 1 });
    return (
      e instanceof ApiError &&
      e.statusCode === 400 &&
      e.message === "m" &&
      e.errorCode === "X" &&
      e.details?.a === 1
    );
  });

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  console.error("FAIL  verify:auth crashed:", (e as Error).message);
  process.exit(1);
});
