import express from "express";
import { ReviewController } from "./review.controller";
import auth from "../../middlewares/auth";

const router = express.Router();

router.post("/", auth("CUSTOMER"), ReviewController.createReview);

router.get("/", ReviewController.getAllReviews);

router.get("/salon/:salonId", ReviewController.getReviewsBySalonId);

router.get("/staff/:staffId", ReviewController.getReviewsByStaffId);

router.get("/:id", ReviewController.getReviewById);

export const ReviewRoutes = router;
