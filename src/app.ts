import express, { Application, Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import router from "./app/routes";
import globalErrorHandler from "./app/middlewares/globalErrorHandler";
import notFound from "./app/middlewares/notFound";

const app: Application = express();

/**
 * Render terminates TLS at its own edge and forwards to this process over plain
 * HTTP, so every request arrives from the proxy's address with the real client
 * in `X-Forwarded-For`. Left at the default `false`, Express reports the proxy
 * as `req.ip` - every visitor shares one bucket - and express-rate-limit
 * refuses to key on a header it was not told to trust:
 *
 *   ValidationError: The 'X-Forwarded-For' header is set but the Express
 *   'trust proxy' setting is false. ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
 *
 * `1` - trust exactly one hop, Render's own - rather than `true`: trusting
 * every hop lets a client prepend its own `X-Forwarded-For` and walk past the
 * limiter by inventing a fresh IP per request.
 */
app.set("trust proxy", 1);

// Middlewares setup
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://salon-management-frontend-kappa.vercel.app",
      "https://salon-management-frontend-fawn.vercel.app",
      "https://salon.ashrafulash.com",
    ],
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health check route
app.get("/", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "Salon Management Server is running!",
  });
});

// Application routes
app.use("/api/v1", router);

// Global error handler
app.use(globalErrorHandler);

// Not found handler
app.use(notFound);

export default app;
