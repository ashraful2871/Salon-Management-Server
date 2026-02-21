import { Router } from "express";
import auth from "../../middlewares/auth";
import { UserRole } from "@prisma/client";
import { CounterController } from "./counter.controller";

const router = Router();

router.post("/", auth(UserRole.SALON_OWNER), CounterController.createCounters);

export const CounterRoutes = router;
