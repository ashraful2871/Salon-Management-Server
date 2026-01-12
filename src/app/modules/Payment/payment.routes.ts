import express from "express";
import { PaymentController } from "./payment.controller";
import auth from "../../middlewares/auth";

const router = express.Router();

router.post(
  "/",
  auth("CUSTOMER", "ADMIN", "SALON_OWNER"),
  PaymentController.createPayment
);

router.get("/", auth("ADMIN", "SALON_OWNER"), PaymentController.getAllPayments);

router.get(
  "/:id",
  auth("ADMIN", "SALON_OWNER", "CUSTOMER"),
  PaymentController.getPaymentById
);

export const PaymentRoutes = router;
