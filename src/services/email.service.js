// src/services/email.service.js
import { Resend } from 'resend';
import logger from '#config/logger.js';
import { generateInvoicePDF } from '../utils/invoiceGenerator.js';
import { withTenantDb } from '#config/tenantContext.js';
import { bookings } from '#models/booking.model.js';
import { and, gte, lte } from 'drizzle-orm';

const escapeHtml = (str) =>
  String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// ✅ Helper functions outside class
const formatCurrency = (amount, currency) => {
  const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
  const symbol = currency === 'USD' ? '$' : 'KSh';
  return `${symbol}${numAmount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const FROM_EMAIL =
  process.env.NODE_ENV === 'production'
    ? 'Footloose Adventures <info@footlooseadventures.co.ke>'
    : 'Footloose Adventures <onboarding@resend.dev>';

const ADMIN_EMAIL =
  process.env.ADMIN_EMAIL || 'footlooseadventures2026@gmail.com';

// ✅ GOOD - Class-based service (easily mockable)
class EmailService {
  constructor() {
    this.resend = new Resend(process.env.RESEND_API_KEY);
    this.fromEmail = FROM_EMAIL;
    this.adminEmail = ADMIN_EMAIL;
  }

  // ✅ Send booking confirmation email
  async sendBookingConfirmation(booking) {
    try {
      // ✅ Add validation logging
      if (!booking.customer_email) {
        logger.error(
          'Cannot send booking confirmation: customer_email is missing',
          {
            bookingId: booking.id,
            booking: JSON.stringify(booking, null, 2),
          }
        );
        throw new Error('Customer email is required');
      }

      logger.info('Sending booking confirmation email:', {
        bookingId: booking.id,
        to: booking.customer_email,
        customerName: booking.customer_name,
        reference: booking.booking_reference,
      });

      const pricePerPerson = booking.price_per_person
        ? parseFloat(booking.price_per_person)
        : parseFloat(booking.total_price) / booking.group_size;

      // Saves the customer hunting for the booking in their account. The page
      // is behind login and scoped to the booking's owner, so the link is only
      // useful to them, and it always shows the current total — including one
      // an admin has since re-priced.
      // Trailing slashes trimmed: a FRONTEND_URL of "https://site/" would
      // otherwise produce "https://site//bookings/...", which is a different
      // path as far as the router is concerned.
      const siteUrl = process.env.FRONTEND_URL?.replace(/\/+$/, '');
      const paymentUrl = siteUrl
        ? `${siteUrl}/bookings/${booking.id}/payment`
        : null;

      const { data, error } = await this.resend.emails.send({
        from: this.fromEmail,
        to: [booking.customer_email],
        subject: `Booking Confirmation - ${booking.booking_reference}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #ff5722;">Booking Confirmed!</h1>
            <p>Dear ${escapeHtml(booking.customer_name)},</p>
            <p>Your safari booking has been confirmed. Here are your details:</p>
            
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h2 style="margin-top: 0;">Booking Details</h2>
              <p><strong>Reference:</strong> ${booking.booking_reference}</p>
              <p><strong>Tour:</strong> ${booking.tour?.title || 'N/A'}</p>
              <p><strong>Start Date:</strong> ${new Date(booking.start_date).toLocaleDateString()}</p>
              <p><strong>End Date:</strong> ${new Date(booking.end_date).toLocaleDateString()}</p>
              <p><strong>Group Size:</strong> ${booking.group_size} ${booking.group_size === 1 ? 'person' : 'people'}</p>
            </div>

            <div style="background: #e8f5e9; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #2e7d32;">Pricing</h2>
              ${
                booking.price_per_person
                  ? `
                <p><strong>Price per person:</strong> ${formatCurrency(pricePerPerson, booking.currency)}</p>
                <p><strong>Number of people:</strong> ${booking.group_size}</p>
                <p style="font-size: 14px; color: #666;">${booking.group_size} × ${formatCurrency(pricePerPerson, booking.currency)}</p>
                <hr style="border: none; border-top: 1px solid #ccc; margin: 15px 0;">
              `
                  : ''
              }
              <p style="font-size: 18px;"><strong>Total Price:</strong> ${formatCurrency(booking.total_price, booking.currency)}</p>
              <p><strong>Payment Status:</strong> <span style="color: ${booking.payment_status === 'paid' ? '#4caf50' : '#ff9800'};">${(booking.payment_status || 'pending').toUpperCase()}</span></p>
            </div>
            
            ${
              booking.special_requests
                ? `
              <div style="background: #fff3e0; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Special Requests:</strong></p>
                <p>${escapeHtml(booking.special_requests)}</p>
              </div>
            `
                : ''
            }
            
            ${
              booking.payment_status !== 'paid'
                ? `
              <div style="background: #fff3e0; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ff9800;">
                <p style="margin: 0;"><strong>⚠️ Payment Pending</strong></p>
                <p style="margin: 10px 0 0 0;">Please complete your payment to confirm your booking.</p>
                ${
                  paymentUrl
                    ? `
                  <div style="margin: 20px 0 5px 0;">
                    <a href="${escapeHtml(paymentUrl)}" style="background: #ff5722; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Pay for this booking</a>
                  </div>
                  <p style="color: #666; font-size: 13px; margin: 12px 0 0 0;">If the button doesn't work, copy this link into your browser:</p>
                  <p style="color: #666; font-size: 13px; word-break: break-all; margin: 4px 0 0 0;">${escapeHtml(paymentUrl)}</p>
                  <p style="color: #666; font-size: 13px; margin: 12px 0 0 0;">You'll be asked to sign in as ${escapeHtml(booking.customer_email)} first.</p>
                `
                    : ''
                }
              </div>
            `
                : ''
            }
            
            <p>We look forward to hosting you on this amazing adventure!</p>
            <p>If you have any questions, please don't hesitate to contact us.</p>
            
            <p>Best regards,<br>Footloose Adventures Team<br>
            📧 info@footlooseadventures.co.ke<br>
            📞 +254 742 060 624</p>
          </div>
        `,
      });

      if (error) {
        logger.error('Failed to send booking confirmation email:', error);
        throw error;
      }

      logger.info('Booking confirmation email sent:', {
        to: booking.customer_email,
        emailId: data.id,
      });
      return data;
    } catch (error) {
      logger.error('Email service error:', error);
      throw error;
    }
  }

  // ✅ Send payment confirmation email with invoice
  async sendPaymentConfirmation(booking) {
    try {
      const invoicePDF = generateInvoicePDF(booking);
      const pricePerPerson = booking.price_per_person
        ? parseFloat(booking.price_per_person)
        : parseFloat(booking.total_price) / booking.group_size;

      const { data, error } = await this.resend.emails.send({
        from: this.fromEmail,
        to: [booking.customer_email],
        subject: `Payment Confirmed - ${booking.booking_reference}`,
        html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #4caf50;">✅ Payment Confirmed!</h1>
          <p>Dear ${escapeHtml(booking.customer_name)},</p>
          <p>We have received your payment for booking <strong>${booking.booking_reference}</strong>.</p>
          
          <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h2 style="margin-top: 0;">Payment Details</h2>
            ${
              booking.price_per_person
                ? `
              <p><strong>Price per person:</strong> ${formatCurrency(pricePerPerson, booking.currency)}</p>
              <p><strong>Number of people:</strong> ${booking.group_size}</p>
              <hr style="border: none; border-top: 1px dashed #ccc; margin: 10px 0;">
            `
                : ''
            }
            <p style="font-size: 18px;"><strong>Amount Paid:</strong> ${formatCurrency(booking.total_price, booking.currency)}</p>
            <p><strong>Payment Method:</strong> ${booking.payment_method === 'mpesa' ? 'M-Pesa' : 'Card'}</p>
            <p><strong>Tour:</strong> ${booking.tour?.title || 'N/A'}</p>
            <p><strong>Date:</strong> ${new Date(booking.start_date).toLocaleDateString()}</p>
          </div>
          
          <div style="background: #e8f5e9; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #4caf50;">
            <p style="margin: 0;">📎 <strong>Your invoice is attached to this email.</strong></p>
          </div>
          
          <p>Your booking is now confirmed. We'll send you further details closer to your tour date.</p>
          
          <p>Best regards,<br>Footloose Adventures Team<br>
          📧 info@footlooseadventures.co.ke<br>
          📞 +254 742 060 624</p>
        </div>
      `,
        attachments: [
          {
            filename: `Invoice-${booking.booking_reference}.pdf`,
            content: invoicePDF,
          },
        ],
      });

      if (error) {
        logger.error('Failed to send payment confirmation email:', error);
        throw error;
      }

      logger.info('Payment confirmation email sent with invoice:', {
        to: booking.customer_email,
        emailId: data.id,
      });

      return data;
    } catch (error) {
      logger.error('Email service error:', error);
      throw error;
    }
  }

  // ✅ Send booking cancellation email
  async sendBookingCancellation(booking) {
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.fromEmail,
        to: [booking.customer_email],
        subject: `Booking Cancelled - ${booking.booking_reference}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #ff5722;">Booking Cancelled</h1>
            <p>Dear ${escapeHtml(booking.customer_name)},</p>
            <p>Your booking has been cancelled as requested.</p>
            
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Reference:</strong> ${booking.booking_reference}</p>
              <p><strong>Tour:</strong> ${booking.tour?.title || 'N/A'}</p>
              <p><strong>Original Date:</strong> ${new Date(booking.start_date).toLocaleDateString()}</p>
              <p><strong>Cancellation Date:</strong> ${new Date().toLocaleDateString()}</p>
              ${booking.cancellation_reason ? `<p><strong>Reason:</strong> ${escapeHtml(booking.cancellation_reason)}</p>` : ''}
            </div>
            
            <p>If you have any questions or would like to rebook, please contact us.</p>
            
            <p>Best regards,<br>Footloose Adventures Team</p>
          </div>
        `,
      });

      if (error) {
        logger.error('Failed to send cancellation email:', error);
        throw error;
      }

      logger.info('Cancellation email sent:', {
        to: booking.customer_email,
        emailId: data.id,
      });
      return data;
    } catch (error) {
      logger.error('Email service error:', error);
      throw error;
    }
  }

  // ✅ Send password reset email
  async sendResetPasswordEmail(user, resetUrl) {
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.fromEmail,
        to: [user.email],
        subject: 'Reset your password - Footloose Adventures',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #ff5722;">Reset Your Password</h1>
            <p>Hi ${user.name || 'there'},</p>
            <p>We received a request to reset the password for your Footloose Adventures account. Click the button below to choose a new password:</p>

            <div style="margin: 30px 0;">
              <a href="${escapeHtml(resetUrl)}" style="background: #ff5722; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a>
            </div>

            <p style="color: #666; font-size: 14px;">If the button doesn't work, copy and paste this link into your browser:</p>
            <p style="color: #666; font-size: 14px; word-break: break-all;">${escapeHtml(resetUrl)}</p>

            <p style="color: #666; font-size: 14px;">This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>

            <p>Best regards,<br>Footloose Adventures Team</p>
          </div>
        `,
      });

      if (error) {
        logger.error('Failed to send reset password email:', error);
        throw error;
      }

      logger.info('Reset password email sent:', {
        emailId: data.id,
      });
      return data;
    } catch (error) {
      logger.error('Email service error:', error);
      throw error;
    }
  }

  // ✅ Send contact form email
  async sendContactFormEmail({ name, email, message, phone }) {
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.fromEmail,
        to: [process.env.CONTACT_EMAIL || 'info@footlooseadventures.co.ke'],
        replyTo: email,
        subject: `New Contact Form Submission from ${escapeHtml(name)}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>New Contact Form Submission</h2>
            <p><strong>Name:</strong> ${escapeHtml(name)}</p>
            <p><strong>Email:</strong> ${escapeHtml(email)}</p>
            ${phone ? `<p><strong>Phone:</strong> ${escapeHtml(phone)}</p>` : ''}
            <p><strong>Message:</strong></p>
            <div style="background: #f5f5f5; padding: 15px; border-radius: 5px;">
              ${escapeHtml(message)}
            </div>
          </div>
        `,
      });

      if (error) {
        logger.error('Failed to send contact form email:', error);
        throw error;
      }

      logger.info('Contact form email sent:', { emailId: data.id });
      return data;
    } catch (error) {
      logger.error('Email service error:', error);
      throw error;
    }
  }

  // ✅ Send inquiry to business
  async sendInquiryEmail(inquiry) {
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.fromEmail,
        to: [process.env.CONTACT_EMAIL || 'info@footlooseadventures.co.ke'],
        replyTo: inquiry.email,
        subject: `Tour Inquiry: ${inquiry.subject}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #ff5722;">New Tour Inquiry</h2>
            
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Contact Information</h3>
              <p><strong>Name:</strong> ${escapeHtml(inquiry.name)}</p>
              <p><strong>Email:</strong> ${inquiry.email}</p>
              <p><strong>Country:</strong> ${inquiry.country}</p>
              <p><strong>Contact:</strong> ${inquiry.contact}</p>
            </div>

            ${
              inquiry.tour_title
                ? `
              <div style="background: #e3f2fd; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Tour of Interest:</strong> ${inquiry.tour_title}</p>
                ${inquiry.tour_id ? `<p><strong>Tour ID:</strong> ${inquiry.tour_id}</p>` : ''}
              </div>
            `
                : ''
            }

            <div style="background: #fff3e0; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Travel Details</h3>
              <p><strong>Adults:</strong> ${inquiry.adults}</p>
              <p><strong>Children:</strong> ${inquiry.children}</p>
              <p><strong>Total Group Size:</strong> ${inquiry.adults + inquiry.children}</p>
            </div>

            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${inquiry.subject}</h3>
              <p style="white-space: pre-wrap;">${inquiry.message}</p>
            </div>

            <p style="color: #666; font-size: 12px;">
              This inquiry was submitted on ${new Date().toLocaleString()}
            </p>
          </div>
        `,
      });

      if (error) {
        logger.error('Failed to send inquiry email:', error);
        throw error;
      }

      logger.info('Inquiry email sent to business:', { emailId: data.id });
      return data;
    } catch (error) {
      logger.error('Email service error:', error);
      throw error;
    }
  }

  // ✅ Send confirmation to customer
  async sendInquiryConfirmation(inquiry) {
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.fromEmail,
        to: [inquiry.email],
        subject: 'We received your inquiry - Footloose Adventures',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #ff5722;">Thank You for Your Inquiry!</h1>
            
            <p>Dear ${escapeHtml(inquiry.name)},</p>
            
            <p>We have received your inquiry about ${inquiry.tour_title || 'our safari tours'} and our team will get back to you within 24 hours.</p>
            
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Your Inquiry Details</h3>
              <p><strong>Subject:</strong> ${inquiry.subject}</p>
              <p><strong>Group Size:</strong> ${inquiry.adults} Adults${inquiry.children > 0 ? `, ${inquiry.children} Children` : ''}</p>
              ${inquiry.tour_title ? `<p><strong>Tour:</strong> ${inquiry.tour_title}</p>` : ''}
            </div>

            <p>Best regards,<br>
            <strong>Footloose Adventures Team</strong><br>
            Email: info@footlooseadventures.co.ke<br>
            Phone: +254 742 060 624</p>
          </div>
        `,
      });

      if (error) {
        logger.error('Failed to send inquiry confirmation:', error);
        throw error;
      }

      logger.info('Inquiry confirmation sent to customer:', {
        to: inquiry.email,
        emailId: data.id,
      });
      return data;
    } catch (error) {
      logger.error('Email service error:', error);
      throw error;
    }
  }

  // ✅ Admin notification for new booking
  async sendAdminBookingNotification(booking) {
    try {
      const groupSize = booking.pax || booking.group_size || 1;

      const { data, error } = await this.resend.emails.send({
        from: this.fromEmail,
        to: [this.adminEmail],
        subject: `🎉 New Booking: ${booking.booking_reference}`,
        html: `
          <!DOCTYPE html>
          <html>
          <body style="font-family: Arial, sans-serif; line-height: 1.6;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: #ff6600; color: white; padding: 20px; text-align: center;">
                <h1>🎉 New Booking Received!</h1>
              </div>
              
              <div style="padding: 20px; background: #f9f9f9;">
                <h2>Booking Details</h2>
                
                <div style="background: white; padding: 20px; margin: 20px 0; border-left: 4px solid #ff6600;">
                  <p><strong>Reference:</strong> ${booking.booking_reference}</p>
                  <p><strong>Tour:</strong> ${booking.tour?.title || 'N/A'}</p>
                  <p><strong>Customer:</strong> ${escapeHtml(booking.customer_name)}</p>
                  <p><strong>Email:</strong> ${booking.customer_email}</p>
                  <p><strong>Phone Number:</strong> ${escapeHtml(booking.customer_phone)}</p>
                  <p><strong>Group Size:</strong> ${groupSize} ${groupSize === 1 ? 'person' : 'people'}</p>
                  <p><strong>Total Amount:</strong> ${booking.currency} ${parseFloat(booking.total_price).toFixed(2)}</p>
                </div>
              </div>
            </div>
          </body>
          </html>
        `,
      });

      if (error) {
        logger.error('Failed to send admin notification:', error);
        throw error;
      }

      logger.info('Admin notification sent:', {
        bookingId: booking.id,
        emailId: data.id,
      });

      return data;
    } catch (error) {
      logger.error('Admin notification error:', error);
      throw error;
    }
  }

  // ✅ Daily booking summary
  //
  // Must be called inside runWithTenant: it runs from a scheduler rather than
  // a request, so there is no middleware to inherit a tenant from. Unscoped,
  // it would put one operator's bookings and revenue into another operator's
  // summary email — see jobs/dailySummary.js, which iterates operators.
  async sendDailyBookingSummary() {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todaysBookings = await withTenantDb((tx) =>
        tx.query.bookings.findMany({
          where: and(
            gte(bookings.created_at, today),
            lte(bookings.created_at, tomorrow)
          ),
          with: { tour: true },
        })
      );

      if (todaysBookings.length === 0) {
        return; // No bookings today
      }

      const totalRevenue = todaysBookings.reduce(
        (sum, b) => sum + parseFloat(b.total_price),
        0
      );

      const paidBookings = todaysBookings.filter(
        (b) => b.payment_status === 'paid'
      ).length;

      const { data, error } = await this.resend.emails.send({
        from: this.fromEmail,
        to: [this.adminEmail],
        subject: `📊 Daily Booking Summary - ${today.toLocaleDateString()}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #ff6600;">Daily Booking Summary</h1>
            <p><strong>Date:</strong> ${today.toLocaleDateString()}</p>
            
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h2>Today's Stats</h2>
              <p><strong>Total Bookings:</strong> ${todaysBookings.length}</p>
              <p><strong>Paid:</strong> ${paidBookings}</p>
              <p><strong>Total Revenue:</strong> KES ${totalRevenue.toFixed(2)}</p>
            </div>
          </div>
        `,
      });

      if (error) {
        logger.error('Failed to send daily summary:', error);
        throw error;
      }

      logger.info('Daily summary sent:', {
        date: today,
        bookingCount: todaysBookings.length,
      });
      return data;
    } catch (error) {
      logger.error('Daily summary error:', error);
      throw error;
    }
  }
}

// ✅ Export singleton instance
export const emailService = new EmailService();

// ✅ Also export class for testing
export { EmailService };
