import { CookieOptions, Response } from "express";

/**
 * One place that decides how the auth cookies are written, so the three
 * endpoints that issue them - register, login and refresh-token - cannot drift
 * apart. They did before: a cookie set with one `path` and cleared with another
 * is not cleared at all, and a logout that only names `refreshToken` leaves the
 * access token sitting in the browser.
 */

export const ACCESS_TOKEN_COOKIE = "accessToken";
export const REFRESH_TOKEN_COOKIE = "refreshToken";

/**
 * The cookies deliberately outlive the JWTs they carry.
 *
 * An expired access token is not junk - it is the evidence that this browser
 * had a session, and the frontend reads it to decide whether a silent refresh
 * is worth attempting. Throwing the cookie away the moment its payload expires
 * would turn every idle hour into a forced sign-in, which is exactly the
 * behaviour the refresh flow exists to remove.
 */
// const ACCESS_COOKIE_MAX_AGE = 5 * 1000; // 5 seconds
const ACCESS_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_COOKIE_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days

const baseOptions: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/",
};

export const setAuthCookies = (
  res: Response,
  tokens: { accessToken: string; refreshToken?: string },
): void => {
  res.cookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    ...baseOptions,
    maxAge: ACCESS_COOKIE_MAX_AGE,
  });

  if (tokens.refreshToken) {
    res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      ...baseOptions,
      maxAge: REFRESH_COOKIE_MAX_AGE,
    });
  }
};

/** `maxAge` is the one option `clearCookie` must not be given; the rest have to match. */
export const clearAuthCookies = (res: Response): void => {
  res.clearCookie(ACCESS_TOKEN_COOKIE, baseOptions);
  res.clearCookie(REFRESH_TOKEN_COOKIE, baseOptions);
};
