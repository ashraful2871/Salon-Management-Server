import express from 'express';
import { AppointmentController } from './appointment.controller';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { AppointmentValidation } from './appointment.validation';

const router = express.Router();

router.post(
  '/',
  auth('CUSTOMER'),
  validateRequest(AppointmentValidation.bookAppointmentValidation),
  AppointmentController.bookAppointment
);

router.get(
  '/',
  auth('ADMIN', 'SALON_OWNER', 'STAFF', 'CUSTOMER'),
  AppointmentController.getAllAppointments
);

router.get(
  '/my-appointments',
  auth('CUSTOMER'),
  AppointmentController.getMyAppointments
);

router.get(
  '/:id',
  auth('ADMIN', 'SALON_OWNER', 'STAFF', 'CUSTOMER'),
  AppointmentController.getAppointmentById
);

router.patch(
  '/:id/status',
  auth('ADMIN', 'SALON_OWNER', 'STAFF', 'CUSTOMER'),
  validateRequest(AppointmentValidation.updateAppointmentStatusValidation),
  AppointmentController.updateAppointmentStatus
);

router.delete('/:id', auth('CUSTOMER'), AppointmentController.cancelAppointment);

export const AppointmentRoutes = router;
