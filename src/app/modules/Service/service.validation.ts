import { z } from 'zod';

const createServiceValidation = z.object({
  body: z.object({
    name: z.string({ required_error: 'Service name is required' }),
    description: z.string().optional(),
    category: z.enum([
      'HAIRCUT',
      'STYLING',
      'COLORING',
      'TREATMENT',
      'SPA',
      'FACIAL',
      'MANICURE',
      'PEDICURE',
      'MAKEUP',
      'WAXING',
      'MASSAGE',
      'OTHER',
    ]),
    price: z.number({ required_error: 'Price is required' }).positive(),
    duration: z.number({ required_error: 'Duration is required' }).positive(),
    salonId: z.string({ required_error: 'Salon ID is required' }),
    images: z.array(z.string()).optional(),
  }),
});

const updateServiceValidation = z.object({
  body: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    category: z
      .enum([
        'HAIRCUT',
        'STYLING',
        'COLORING',
        'TREATMENT',
        'SPA',
        'FACIAL',
        'MANICURE',
        'PEDICURE',
        'MAKEUP',
        'WAXING',
        'MASSAGE',
        'OTHER',
      ])
      .optional(),
    price: z.number().positive().optional(),
    duration: z.number().positive().optional(),
    images: z.array(z.string()).optional(),
    isActive: z.boolean().optional(),
  }),
});

export const ServiceValidation = {
  createServiceValidation,
  updateServiceValidation,
};
