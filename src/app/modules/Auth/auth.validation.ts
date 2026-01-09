import { z } from 'zod';

const registerValidation = z.object({
  body: z.object({
    email: z.string({ required_error: 'Email is required' }).email('Invalid email format'),
    password: z
      .string({ required_error: 'Password is required' })
      .min(6, 'Password must be at least 6 characters'),
    name: z.string({ required_error: 'Name is required' }),
    phone: z.string().optional(),
    gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
    dateOfBirth: z.string().optional(),
    address: z.string().optional(),
    role: z.enum(['CUSTOMER', 'SALON_OWNER']).optional(),
  }),
});

const loginValidation = z.object({
  body: z.object({
    email: z.string({ required_error: 'Email is required' }).email('Invalid email format'),
    password: z.string({ required_error: 'Password is required' }),
  }),
});

const changePasswordValidation = z.object({
  body: z.object({
    oldPassword: z.string({ required_error: 'Old password is required' }),
    newPassword: z
      .string({ required_error: 'New password is required' })
      .min(6, 'Password must be at least 6 characters'),
  }),
});

const refreshTokenValidation = z.object({
  body: z.object({
    refreshToken: z.string({ required_error: 'Refresh token is required' }),
  }),
});

export const AuthValidation = {
  registerValidation,
  loginValidation,
  changePasswordValidation,
  refreshTokenValidation,
};
