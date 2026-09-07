import { z } from 'zod';

export const userIdSchema = z.object({
  id: z.string().min(1, 'ID is required'),
});

export const updateUserSchema = z
  .object({
    name: z.string().min(2).max(255).trim().optional(),
    email: z.string().email().max(255).toLowerCase().trim().optional(),
    role: z.enum(['user', 'admin']).optional(),
  })
  .refine(
    (data) => {
      // Ensure at least one field is provided for update
      return Object.keys(data).length > 0;
    },
    {
      message: 'At least one field must be provided for update',
    }
  );
