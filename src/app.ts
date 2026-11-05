import express, { Application, Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import router from "./app/routes";
import globalErrorHandler from "./app/middlewares/globalErrorHandler";
import notFound from "./app/middlewares/notFound";

import { SITE_NAME } from "./app/utils/brand";
const app: Application = express();

app.set("trust proxy", 1);

// Middlewares setup
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://10.10.13.169:3000",
      "https://salon-management-frontend-kappa.vercel.app",
      "https://salon-management-frontend-fawn.vercel.app",
      "https://salon.ashrafulash.com",
      "https://www.styliobd.online",
      "https://styliobd.online",
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
    message: `${SITE_NAME} Server is running!`,
  });
});

// Application routes
app.use("/api/v1", router);

// Global error handler
app.use(globalErrorHandler);

// Not found handler
app.use(notFound);

export default app;
