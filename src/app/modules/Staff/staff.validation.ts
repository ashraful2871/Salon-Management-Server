import { z } from 'zod';

const addStaffValidation = z.object({
  body: z.object({
    userId: z.string({ required_error: 'User ID is required' }),
    salonId: z.string({ required_error: 'Salon ID is required' }),
    speciality: z.string().optional(),
    experience: z.number().optional(),
    bio: z.string().optional(),
    serviceIds: z.array(z.string()).optional(),
  }),
});

const updateStaffValidation = z.object({
  body: z.object({
    speciality: z.string().optional(),
    experience: z.number().optional(),
    bio: z.string().optional(),
    status: z.enum(['AVAILABLE', 'BUSY', 'ON_LEAVE', 'INACTIVE']).optional(),
    serviceIds: z.array(z.string()).optional(),
  }),
});

export const StaffValidation = {
  addStaffValidation,
  updateStaffValidation,
};
