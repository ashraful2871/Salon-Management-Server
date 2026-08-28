import express from "express";
import auth from "../../middlewares/auth";
import { UserRole } from "@prisma/client";
import validateRequest from "../../middlewares/validateRequest";
import { SlotController } from "./slot.controller";
import { SlotValidation } from "./slot.validation";

const router = express.Router();

router.post(
  "/bulk-create",
  auth(UserRole.SALON_OWNER),
  validateRequest(SlotValidation.bulkCreateSlotsValidation),
  SlotController.bulkCreateSlots
);

router.get(
  "/",
  SlotController.getSlots
);

router.patch(
  "/:id/status",
  auth(UserRole.SALON_OWNER),
  validateRequest(SlotValidation.updateSlotStatusValidation),
  SlotController.updateSlotStatus
);

router.delete(
  "/:id",
  auth(UserRole.SALON_OWNER),
  SlotController.deleteSlot
);

export const SlotRoutes = router;
