import express from "express";
import validateRequest from "../../middlewares/validateRequest";
import { contactLimiter } from "../../middlewares/rateLimiter";
import { ContactController } from "./contact.controller";
import { ContactValidation } from "./contact.validation";

const router = express.Router();

router.post(
  "/",
  contactLimiter,
  validateRequest(ContactValidation.sendContact),
  ContactController.sendContact,
);

export const ContactRoutes = router;
