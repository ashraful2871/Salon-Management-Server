import { ZodObject, ZodRawShape } from "zod";
import { Request, Response, NextFunction } from "express";

/**
 * `replaceBody`: hand the handler the *parsed* body instead of the raw one, so
 * keys the schema does not name are stripped and its defaults applied. Opt-in,
 * because the other modules were written against the raw body; the assistant
 * uses it so no free-form object reaches a handler or its transcript.
 */
const validateRequest = (
  schema: ZodObject<ZodRawShape>,
  options: { replaceBody?: boolean } = {},
) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      if (options.replaceBody) req.body = (parsed as { body?: unknown }).body;
      next();
    } catch (error) {
      next(error);
    }
  };
};

export default validateRequest;
