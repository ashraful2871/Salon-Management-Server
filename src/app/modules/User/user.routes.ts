import express from 'express';
import { UserController } from './user.controller';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { UserValidation } from './user.validation';

const router = express.Router();

router.get('/', auth('ADMIN'), UserController.getAllUsers);

router.get('/:id', auth('ADMIN', 'SALON_OWNER', 'CUSTOMER', 'STAFF'), UserController.getUserById);

router.patch(
  '/:id',
  auth('ADMIN', 'SALON_OWNER', 'CUSTOMER', 'STAFF'),
  validateRequest(UserValidation.updateUserValidation),
  UserController.updateUser
);

router.patch(
  '/:id/status',
  auth('ADMIN'),
  validateRequest(UserValidation.updateUserStatusValidation),
  UserController.updateUserStatus
);

router.patch(
  '/:id/role',
  auth('ADMIN'),
  validateRequest(UserValidation.updateUserRoleValidation),
  UserController.updateUserRole
);

router.delete('/:id', auth('ADMIN'), UserController.deleteUser);

export const UserRoutes = router;
