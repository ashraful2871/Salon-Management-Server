import { Request, Response, NextFunction } from "express";
import { StatusCodes } from "http-status-codes";
import { ZodError } from "zod";
import ApiError from "../Error/error";

const globalErrorHandler = (
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  let statusCode = StatusCodes.INTERNAL_SERVER_ERROR;
  let message = "Something went wrong!";
  let errorDetails = null;

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    statusCode = StatusCodes.BAD_REQUEST;
    message = "Validation error";
    errorDetails = err.issues.map((error) => ({
      path: error.path
        .filter((p) => typeof p === "string" || typeof p === "number")
        .join("."),
      message: error.message,
    }));
  }
  // Handle Prisma errors
  else if (err.name === "PrismaClientKnownRequestError") {
    if (err.code === "P2002") {
      statusCode = StatusCodes.CONFLICT;
      message = "Unique constraint violation";
      errorDetails = err.meta;
    } else if (err.code === "P2025") {
      statusCode = StatusCodes.NOT_FOUND;
      message = "Record not found";
    } else if (err.code === "P2003") {
      statusCode = StatusCodes.BAD_REQUEST;
      message = "Foreign key constraint failed";
      errorDetails = err.meta;
    }
  } else if (err.name === "PrismaClientValidationError") {
    statusCode = StatusCodes.BAD_REQUEST;
    message = "Validation error";
  }
  /**
   * jsonwebtoken's own errors, which the `auth` middleware hands straight over.
   *
   * Without this branch they fell through to the generic `Error` case and left
   * as `500 jwt expired` - indistinguishable from a database outage. A client
   * cannot know to refresh its token from a 500, so an hour-old session looked
   * like a broken server instead of one that needed renewing.
   */
  else if (err.name === "TokenExpiredError") {
    statusCode = StatusCodes.UNAUTHORIZED;
    message = "Your session has expired. Please sign in again.";
  } else if (
    err.name === "JsonWebTokenError" ||
    err.name === "NotBeforeError"
  ) {
    statusCode = StatusCodes.UNAUTHORIZED;
    message = "Invalid authentication token.";
  }
  // Handle custom ApiError
  else if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
  }
  // Handle other errors
  else if (err instanceof Error) {
    message = err.message;
  }

  res.status(statusCode).json({
    success: false,
    message,
    errorDetails,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
};

export default globalErrorHandler;
