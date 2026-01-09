import express from 'express';
import { SalonController } from './salon.controller';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { SalonValidation } from './salon.validation';

const router = express.Router();

router.post(
  '/',
  auth('SALON_OWNER'),
  validateRequest(SalonValidation.createSalonValidation),
  SalonController.createSalon
);

router.get('/', SalonController.getAllSalons);

router.get('/my-salons', auth('SALON_OWNER'), SalonController.getMySalons);

router.get('/:id', SalonController.getSalonById);

router.patch(
  '/:id',
  auth('SALON_OWNER'),
  validateRequest(SalonValidation.updateSalonValidation),
  SalonController.updateSalon
);

router.patch(
  '/:id/status',
  auth('ADMIN'),
  validateRequest(SalonValidation.updateSalonStatusValidation),
  SalonController.updateSalonStatus
);

router.delete('/:id', auth('SALON_OWNER', 'ADMIN'), SalonController.deleteSalon);

export const SalonRoutes = router;
