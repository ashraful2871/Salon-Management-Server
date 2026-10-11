import express from "express";
import auth from "../../middlewares/auth";
import { BUSINESS_ROLES } from "../../utils/salonAccess";
import { OwnerController } from "./owner.controller";

const router = express.Router();

router.get("/access", auth(...BUSINESS_ROLES), OwnerController.getAccess);

export const OwnerRoutes = router;
