import express from 'express';
import { AuthController } from './auth.controller';
import validateRequest from '../../middlewares/validateRequest';
import { AuthValidation } from './auth.validation';
import auth from '../../middlewares/auth';

const router = express.Router();

router.post(
  '/register',
  validateRequest(AuthValidation.registerValidation),
  AuthController.register
);

router.post(
  '/login',
  validateRequest(AuthValidation.loginValidation),
  AuthController.login
);

router.post('/logout', AuthController.logout);

router.post(
  '/refresh-token',
  validateRequest(AuthValidation.refreshTokenValidation),
  AuthController.refreshToken
);

router.post(
  '/change-password',
  auth('CUSTOMER', 'STAFF', 'SALON_OWNER', 'ADMIN'),
  validateRequest(AuthValidation.changePasswordValidation),
  AuthController.changePassword
);

router.get(
  '/me',
  auth('CUSTOMER', 'STAFF', 'SALON_OWNER', 'ADMIN'),
  AuthController.getMyProfile
);

export const AuthRoutes = router;
