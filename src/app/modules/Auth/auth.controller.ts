import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import ApiError from "../../Error/error";
import { clearAuthCookies, setAuthCookies } from "../../utils/authCookies";
import { AuthService } from "./auth.service";

const register = catchAsync(async (req: Request, res: Response) => {
  const result = await AuthService.register(req.body);

  // Registration signs the user straight in, so it hands back the same cookie
  // and token pair as login rather than sending them to the login screen.
  setAuthCookies(res, result);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "User registered successfully",
    data: {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    },
  });
});

const login = catchAsync(async (req: Request, res: Response) => {
  const result = await AuthService.login(req.body);

  setAuthCookies(res, result);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "User logged in successfully",
    data: {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    },
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

  await AuthService.changePassword(userId, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Password changed successfully",
    data: null,
  });
});

const changeEmail = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await AuthService.changeEmail(userId, req.body);

  // The old tokens still name the old address, so the caller is handed a new
  // pair the same way login does.
  setAuthCookies(res, result);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message:
      "Email changed successfully. We sent a verification link to your new address.",
    data: {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    },
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
  console.log(userId);

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

const verifyEmail = catchAsync(async (req: Request, res: Response) => {
  await AuthService.verifyEmail(req.body);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Email verified successfully',
    data: null,
  });
});

const resendVerification = catchAsync(async (req: Request, res: Response) => {
  await AuthService.resendVerification(req.body);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message:
      'If that account exists and is not yet verified, a new verification link has been sent.',
    data: null,
  });
});

export const AuthController = {
  register,
  login,
  refreshToken,
  changePassword,
  changeEmail,
  logout,
  getMyProfile,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
};
