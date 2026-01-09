import { z } from 'zod';

const bookAppointmentValidation = z.object({
  body: z.object({
    salonId: z.string({ required_error: 'Salon ID is required' }),
    serviceId: z.string({ required_error: 'Service ID is required' }),
    staffId: z.string({ required_error: 'Staff ID is required' }),
    appointmentDate: z.string({ required_error: 'Appointment date is required' }),
    startTime: z.string({ required_error: 'Start time is required' }),
    notes: z.string().optional(),
  }),
});

const updateAppointmentStatusValidation = z.object({
  body: z.object({
    status: z.enum([
      'PENDING',
      'CONFIRMED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ]),
    cancellationReason: z.string().optional(),
  }),
});

export const AppointmentValidation = {
  bookAppointmentValidation,
  updateAppointmentStatusValidation,
};
