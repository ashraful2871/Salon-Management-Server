import express, { NextFunction, Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import { adminSensitiveLimiter } from "../../../middlewares/rateLimiter";
import validateRequest from "../../../middlewares/validateRequest";
import { isSettingKey, SETTINGS, settingPermission } from "../../../utils/settings";
import { adminAuth, adminOnly, requireStepUp } from "../admin.middleware";
import { AdminSettingsController } from "./settings.controller";
import { AdminSettingsValidation } from "./settings.validation";

/**
 * /admin/settings - platform settings, behind the /admin gate. Admins only.
 * A write needs the key's own permission: flags.manage for flags (tier 2),
 * content.manage for content.* (tier 2), settings.manage otherwise (tier 3,
 * step-up).
 */
const router = express.Router();

const stepUp = requireStepUp();

const keyPermission = (req: Request, res: Response, next: NextFunction) => {
  const { key } = req.params;
  if (!isSettingKey(key)) return next(new ApiError(StatusCodes.NOT_FOUND, "Unknown setting"));
  if (!req.admin?.permissions.includes(settingPermission(key))) {
    return next(new ApiError(StatusCodes.FORBIDDEN, "Forbidden"));
  }
  if (SETTINGS[key].tier === 3) return void stepUp(req, res, next);
  next();
};

router.get("/", adminAuth("settings.view"), adminOnly, AdminSettingsController.list);
router.get(
  "/:key/history",
  adminAuth("settings.view"),
  adminOnly,
  AdminSettingsController.history,
);
router.patch(
  "/:key",
  adminAuth(),
  adminOnly,
  validateRequest(AdminSettingsValidation.update, { replaceBody: true }),
  adminSensitiveLimiter,
  keyPermission,
  AdminSettingsController.update,
);

export const AdminSettingsRoutes = router;
