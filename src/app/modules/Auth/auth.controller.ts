import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import ApiError from "../../Error/error";
import { clearAuthCookies, setAuthCookies } from "../../utils/authCookies";
import { clientIp } from "../../middlewares/rateLimiter";
import { AuthService } from "./auth.service";
import { completeGoogleFlow, startGoogleFlow } from "./auth.google";
import { isGoogleEnabled } from "../../../config";

const register = catchAsync(async (req: Request, res: Response) => {
  const result = await AuthService.register(req.body, clientIp(req));

  // With REQUIRE_EMAIL_VERIFICATION on, no session until the code: no cookies.
  if (result.status === "VERIFICATION_REQUIRED") {
    sendResponse(res, {
      statusCode: StatusCodes.CREATED,
      success: true,
      message: "Account created. Enter the 6-digit code we emailed you.",
      data: result,
    });
    return;
  }

  // Otherwise registration signs the user straight in, so it hands back the
  // same cookie and token pair as login rather than sending them to sign in.
  setAuthCookies(res, result);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "User registered successfully",
    data: {
      status: result.status,
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    },
  });
});

// The tokens stay at the top level of `data`, where older frontends read them.
const login = catchAsync(async (req: Request, res: Response) => {
  const result = await AuthService.login(req.body, clientIp(req));

  if (result.status === "SIGNED_IN") {
    setAuthCookies(res, result);
  }

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message:
      result.status === "SIGNED_IN"
        ? "User logged in successfully"
        : "Verify your email to continue",
    data: result,
  });
});

const verifyOtp = catchAsync(async (req: Request, res: Response) => {
  const result = await AuthService.verifyOtp(req.body);

  setAuthCookies(res, result);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Email verified. Welcome to SalonKhuji!",
    data: result,
  });
});

const resendOtp = catchAsync(async (req: Request, res: Response) => {
  const result = await AuthService.resendOtp(req.body, clientIp(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "We sent a new code.",
    data: result,
  });
});

/**
 * The token is looked for in the cookie first and the body second.
 *
 * `req.body || req.cookies` - what this used to do - never reached the cookie:
 * `express.json()` leaves `req.body` as an object on every request, and an
 * object is truthy, so a browser-only caller always destructured `undefined`
 * out of an empty body. Both sources are supported on purpose: the browser
 * sends the cookie, while the Next.js server holds the token itself and posts
 * it in the body.
 */
const refreshToken = catchAsync(async (req: Request, res: Response) => {
  const token: unknown =
    req.cookies?.refreshToken ?? req.body?.refreshToken ?? null;

  if (typeof token !== "string" || !token.trim()) {
    throw new ApiError(
      StatusCodes.UNAUTHORIZED,
      "Refresh token is required. Please sign in again.",
    );
  }

  const result = await AuthService.refreshToken(token.trim());

  setAuthCookies(res, result);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Access token refreshed successfully",
    data: result,
  });
});

const changePassword = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await AuthService.changePassword(userId, req.body);

  // Every other session was just ended; this one continues on a fresh pair.
  setAuthCookies(res, result);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Password changed. Other devices have been signed out.",
    data: result,
  });
});

const changeEmail = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await AuthService.changeEmail(userId, req.body, clientIp(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "We sent a code to your new email",
    data: result,
  });
});

const confirmEmailChange = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await AuthService.confirmEmailChange(userId, req.body);

  // The old tokens name the old address and an older sessionVersion, so the
  // caller is handed a new pair the same way login does.
  setAuthCookies(res, result);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Your email has been changed",
    data: result,
  });
});

const logout = catchAsync(async (_req: Request, res: Response) => {
  // Both cookies, with the same options they were written with - clearing only
  // the refresh token left a still-valid access token behind for up to an hour.
  clearAuthCookies(res);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "User logged out successfully",
    data: null,
  });
});

const getMyProfile = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await AuthService.getMyProfile(userId);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Profile retrieved successfully",
    data: result,
  });
});

const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  await AuthService.forgotPassword(req.body);

  // Deliberately identical whether or not the address is registered.
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message:
      'If an account exists for that email, a password reset link has been sent.',
    data: null,
  });
});

const resetPassword = catchAsync(async (req: Request, res: Response) => {
  await AuthService.resetPassword(req.body);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Password reset successfully. You can now sign in.',
    data: null,
  });
});

const providers = catchAsync(async (_req: Request, res: Response) => {
  res.set("Cache-Control", "public, max-age=300");

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Sign-in providers",
    data: { google: isGoogleEnabled() },
  });
});

const googleStart = catchAsync(async (req: Request, res: Response) => {
  const result = startGoogleFlow(req.body);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Continue to Google",
    data: result,
  });
});

const googleCallback = catchAsync(async (req: Request, res: Response) => {
  const result = await completeGoogleFlow({ ...req.body, ip: clientIp(req) });

  if (result.status === "SIGNED_IN") {
    setAuthCookies(res, result);
  }

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message:
      result.status === "SIGNED_IN"
        ? "Signed in with Google"
        : "Verify your email to finish creating your account",
    data: result,
  });
});

export const AuthController = {
  register,
  login,
  verifyOtp,
  resendOtp,
  refreshToken,
  changePassword,
  changeEmail,
  confirmEmailChange,
  logout,
  getMyProfile,
  forgotPassword,
  resetPassword,
  providers,
  googleStart,
  googleCallback,
};
