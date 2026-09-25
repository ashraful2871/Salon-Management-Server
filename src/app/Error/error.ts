class ApiError extends Error {
  statusCode: number;
  /** A stable machine-readable reason the frontend can branch on. */
  errorCode?: string;
  details?: Record<string, unknown>;

  constructor(statusCode: number, message: string | undefined, stack = '') {
    super(message);
    this.statusCode = statusCode;

    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  static withCode(
    status: number,
    message: string,
    errorCode: string,
    details?: Record<string, unknown>
  ) {
    const e = new ApiError(status, message);
    e.errorCode = errorCode;
    e.details = details;
    return e;
  }
}

export default ApiError;
