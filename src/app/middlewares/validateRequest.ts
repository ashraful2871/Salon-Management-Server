import { ZodObject, ZodRawShape } from "zod";
import { Request, Response, NextFunction } from "express";

const validateRequest = (schema: ZodObject<ZodRawShape>) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
};

export default validateRequest;
