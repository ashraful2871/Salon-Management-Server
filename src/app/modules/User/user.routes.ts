import express from "express";
import { UserController } from "./user.controller";
import auth from "../../middlewares/auth";
import { adminAuth, requireStepUp } from "../Admin/admin.middleware";
import { adminSensitiveLimiter } from "../../middlewares/rateLimiter";
import validateRequest from "../../middlewares/validateRequest";
import { UserValidation } from "./user.validation";

const router = express.Router();

router.get("/", adminAuth("users.view"), UserController.getAllUsers);

router.get(
  "/my-customers",
  auth("SALON_OWNER"),
  UserController.getMyCustomers,
);

router.get(
  "/:id",
  auth("ADMIN", "SALON_OWNER", "CUSTOMER", "STAFF"),
  UserController.getUserById,
);

router.patch(
  "/:id",
  auth("ADMIN", "SALON_OWNER", "CUSTOMER", "STAFF"),
  validateRequest(UserValidation.updateUserValidation),
  UserController.updateUser,
);

router.patch(
  "/:id/status",
  adminAuth("users.manage"),
  validateRequest(UserValidation.updateUserStatusValidation),
  UserController.updateUserStatus,
);

router.patch(
  "/:id/role",
  adminAuth("users.role"),
  validateRequest(UserValidation.updateUserRoleValidation),
  adminSensitiveLimiter,
  requireStepUp(),
  UserController.updateUserRole,
);

router.delete(
  "/:id",
  adminAuth("users.delete"),
  adminSensitiveLimiter,
  requireStepUp(),
  UserController.deleteUser,
);

export const UserRoutes = router;
