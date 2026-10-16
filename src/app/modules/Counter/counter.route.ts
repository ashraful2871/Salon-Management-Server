import { Router } from "express";
import auth from "../../middlewares/auth";
import { UserRole } from "@prisma/client";
import { CounterController } from "./counter.controller";
import { BUSINESS_ROLES } from "../../utils/salonAccess";

const router = Router();

router.post("/", auth(...BUSINESS_ROLES), CounterController.createCounters);

router.get("/", auth(...BUSINESS_ROLES, UserRole.ADMIN), CounterController.getAllCounters);

router.get("/:id", auth(...BUSINESS_ROLES, UserRole.ADMIN), CounterController.getCounterById);

export const CounterRoutes = router;
