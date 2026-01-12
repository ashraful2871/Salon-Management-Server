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
