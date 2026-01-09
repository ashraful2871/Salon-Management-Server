import express from 'express';
import { StaffController } from './staff.controller';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { StaffValidation } from './staff.validation';

const router = express.Router();

router.post(
  '/',
  auth('SALON_OWNER'),
  validateRequest(StaffValidation.addStaffValidation),
  StaffController.addStaff
);

router.get('/', StaffController.getAllStaff);

router.get('/:id', StaffController.getStaffById);

router.patch(
  '/:id',
  auth('SALON_OWNER'),
  validateRequest(StaffValidation.updateStaffValidation),
  StaffController.updateStaff
);

router.delete('/:id', auth('SALON_OWNER'), StaffController.removeStaff);

export const StaffRoutes = router;
