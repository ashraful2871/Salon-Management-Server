import { Request, RequestHandler, Response } from 'express';

const catchAsync = (fn: RequestHandler): RequestHandler => {
  return async (req: Request, res: Response, next: Function) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      next(error);
    }
  };
};

export default catchAsync;
