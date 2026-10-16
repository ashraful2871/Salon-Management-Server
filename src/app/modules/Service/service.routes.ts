import express from "express";
import { ServiceController } from "./service.controller";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { ServiceValidation } from "./service.validation";
import { BUSINESS_ROLES } from "../../utils/salonAccess";

const router = express.Router();

router.post(
  "/",
  auth(...BUSINESS_ROLES),
  validateRequest(ServiceValidation.createServiceValidation),
  ServiceController.createService,
);

router.get("/", ServiceController.getAllServices);

router.get(
  "/my-services",
  auth(...BUSINESS_ROLES),
  ServiceController.getMyServices,
);

router.get("/:id", ServiceController.getServiceById);

router.patch(
  "/:id",
  auth(...BUSINESS_ROLES),
  validateRequest(ServiceValidation.updateServiceValidation),
  ServiceController.updateService,
);

router.delete("/:id", auth(...BUSINESS_ROLES), ServiceController.deleteService);

export const ServiceRoutes = router;
