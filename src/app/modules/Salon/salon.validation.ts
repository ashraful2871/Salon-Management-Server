import { z } from 'zod';

const createSalonValidation = z.object({
  body: z.object({
    name: z.string({ required_error: 'Salon name is required' }),
    description: z.string().optional(),
    address: z.string({ required_error: 'Address is required' }),
    city: z.string({ required_error: 'City is required' }),
    state: z.string().optional(),
    zipCode: z.string().optional(),
    phone: z.string({ required_error: 'Phone is required' }),
    email: z.string().email().optional(),
    images: z.array(z.string()).optional(),
    operatingHours: z.any().optional(),
  }),
});

const updateSalonValidation = z.object({
  body: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zipCode: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    images: z.array(z.string()).optional(),
    operatingHours: z.any().optional(),
  }),
});

const updateSalonStatusValidation = z.object({
  body: z.object({
    status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING_APPROVAL', 'REJECTED']),
  }),
});

export const SalonValidation = {
  createSalonValidation,
  updateSalonValidation,
  updateSalonStatusValidation,
};
