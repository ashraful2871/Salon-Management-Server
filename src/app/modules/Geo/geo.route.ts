import express from "express";
import { GeoController } from "./geo.controller";
import { geoLimiter } from "../../middlewares/rateLimiter";

const router = express.Router();

// Public: the location dialog and the salon form both use these before login.
router.get("/search", geoLimiter, GeoController.search);
router.get("/reverse", geoLimiter, GeoController.reverse);

export const GeoRoutes = router;
