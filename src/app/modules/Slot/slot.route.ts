import express from "express";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { UserRole } from "@prisma/client";
import { SlotController } from "./slot.controller";
import { SlotValidation } from "./slot.validation";
import { BUSINESS_ROLES } from "../../utils/salonAccess";

const router = express.Router();

router.post(
  "/bulk-create",
  auth(...BUSINESS_ROLES),
  validateRequest(SlotValidation.bulkCreateSlotsValidation),
  SlotController.bulkCreateSlots
);

router.get("/", SlotController.getSlots);

router.patch(
  "/:id/status",
  auth(...BUSINESS_ROLES),
  validateRequest(SlotValidation.updateSlotStatusValidation),
  SlotController.updateSlotStatus
);

router.post(
  "/bulk-delete",
  auth(...BUSINESS_ROLES),
  validateRequest(SlotValidation.deleteBulkSlotsValidation),
  SlotController.deleteBulkSlots
);

router.delete("/:id", auth(...BUSINESS_ROLES), SlotController.deleteSlot);

export const SlotRoutes = router;
