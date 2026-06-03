import express from "express";
import { ServiceController } from "./service.controller";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { ServiceValidation } from "./service.validation";

const router = express.Router();

router.post(
  "/",
  auth("SALON_OWNER"),
  validateRequest(ServiceValidation.createServiceValidation),
  ServiceController.createService,
);

router.get("/", ServiceController.getAllServices);

router.get(
  "/my-services",
  auth("SALON_OWNER"),
  ServiceController.getMyServices,
);

router.get("/:id", ServiceController.getServiceById);

router.patch(
  "/:id",
  auth("SALON_OWNER"),
  validateRequest(ServiceValidation.updateServiceValidation),
  ServiceController.updateService,
);

router.delete("/:id", auth("SALON_OWNER"), ServiceController.deleteService);

export const ServiceRoutes = router;
