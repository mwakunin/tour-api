// src/jobs/dailySummary.js
import { emailService } from '../services/email.service.js';
import logger from '../config/logger.js';

export const sendDailySummary = async () => {
  try {
    logger.info('Sending daily booking summary...');
    await emailService.sendDailyBookingSummary();
    logger.info('Daily summary sent successfully');
  } catch (error) {
    logger.error('Failed to send daily summary:', error);
  }
};

// Run every day at 8 PM
// You can use node-cron or run this via a scheduler
