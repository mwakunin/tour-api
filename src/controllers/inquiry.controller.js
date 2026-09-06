// ============================================
// FILE: src/controllers/inquiry.controller.js
// ============================================
import { z } from 'zod';
import { emailService } from '#services/email.service.js';
import logger from '#config/logger.js';

const inquirySchema = z
  .object({
    name: z.string().min(3, 'Name must be at least 3 characters'),
    email: z.string().email('Invalid email address'),
    country: z.string().min(2, 'Country is required'),
    contact: z.string().min(5, 'Contact number is required'),
    adults: z.number().int().min(1, 'At least 1 adult required').max(30),
    children: z.number().int().min(0).max(30),
    subject: z.string().min(5, 'Subject is required'),
    message: z.string().min(20, 'Message must be at least 20 characters'),
    tour_id: z.string().uuid().optional(),
    tour_title: z.string().optional(),
  })
  .refine((data) => data.adults + data.children <= 30, {
    message: 'Total group size cannot exceed 30 people',
    path: ['adults'],
  });

export const createInquiry = async (req, res) => {
  try {
    // Validate input
    const validated = inquirySchema.parse(req.body);

    // Send inquiry email to business
    await emailService.sendInquiryEmail(validated);

    // Send confirmation to customer
    await emailService.sendInquiryConfirmation(validated);

    return res.status(200).json({
      success: true,
      message: 'Inquiry sent successfully',
    });
  } catch (error) {
    // Check for Zod validation error multiple ways
    if (
      error instanceof z.ZodError ||
      error.name === 'ZodError' ||
      error.constructor.name === 'ZodError'
    ) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details:
          error.issues?.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })) || [],
      });
    }

    logger.error('Inquiry submission error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to send inquiry. Please try again later.',
    });
  }
};
