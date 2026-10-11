import express from "express";
import { ReviewController } from "./review.controller";
import auth from "../../middlewares/auth";
import validateRequest from "../../middlewares/validateRequest";
import { reviewReportLimiter } from "../../middlewares/rateLimiter";
import { ReviewValidation } from "./review.validation";

const router = express.Router();

router.post("/", auth("CUSTOMER"), ReviewController.createReview);

router.get("/", ReviewController.getAllReviews);

// A customer, or the owner of the reviewed salon, flags a review for moderation.
router.post(
  "/:id/report",
  auth("CUSTOMER", "SALON_OWNER"),
  reviewReportLimiter,
  validateRequest(ReviewValidation.report, { replaceBody: true }),
  ReviewController.reportReview,
);

router.get("/salon/:salonId", ReviewController.getReviewsBySalonId);

router.get("/staff/:staffId", ReviewController.getReviewsByStaffId);

router.get("/:id", ReviewController.getReviewById);

export const ReviewRoutes = router;
