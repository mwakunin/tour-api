// ============================================
// FILE: src/controllers/contact.controller.js
// ============================================
import { emailService } from '#services/email.service.js';
import { z } from 'zod';
import logger from '#config/logger.js';

const contactSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Invalid email address'),
  phone: z.string().optional(),
  message: z
    .string()
    .min(20, 'Message must be at least 20 characters')
    .max(1000),
});

export const sendContactMessage = async (req, res) => {
  try {
    // Validate input
    const validated = contactSchema.parse(req.body);

    // Send email
    await emailService.sendContactFormEmail(validated);

    return res.status(200).json({
      success: true,
      message: 'Message sent successfully',
    });
  } catch (error) {
    // Check for Zod validation error multiple ways
    if (
      error instanceof z.ZodError ||
      error.name === 'ZodError' ||
      error.constructor.name === 'ZodError'
    ) {
      console.log('🔍 Zod error detected'); // DEBUG
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

    logger.error('Contact form error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to send message. Please try again later.',
    });
  }
};
