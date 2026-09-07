import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { EmailService } from '#services/email.service.js';

const unpaidBooking = {
  id: '11111111-2222-3333-4444-555555555555',
  booking_reference: 'FA-TEST-001',
  customer_name: 'Jane Traveller',
  customer_email: 'jane@example.com',
  tour: { title: 'Test Safari' },
  start_date: '2026-09-01',
  end_date: '2026-09-04',
  group_size: 2,
  price_per_person: '500.00',
  total_price: '1000.00',
  currency: 'USD',
  payment_status: 'pending',
};

/** Renders the real template, capturing what would have gone to Resend. */
const renderConfirmation = async (booking) => {
  const service = new EmailService();
  const send = jest
    .fn()
    .mockResolvedValue({ data: { id: 'test' }, error: null });
  service.resend = { emails: { send } };

  await service.sendBookingConfirmation(booking);

  return send.mock.calls[0][0].html;
};

describe('Booking confirmation email', () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  afterEach(() => {
    // Assigning undefined would store the string "undefined", which reads as a
    // valid base URL to everything downstream
    if (originalFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = originalFrontendUrl;
    }
  });

  it('links straight to the payment page while the booking is unpaid', async () => {
    process.env.FRONTEND_URL = 'https://example.test';

    const html = await renderConfirmation(unpaidBooking);

    expect(html).toContain(
      `https://example.test/bookings/${unpaidBooking.id}/payment`
    );
    expect(html).toContain('Pay for this booking');
  });

  it('keeps exactly one slash when FRONTEND_URL has a trailing one', async () => {
    process.env.FRONTEND_URL = 'https://example.test/';

    const html = await renderConfirmation(unpaidBooking);

    expect(html).toContain(
      `https://example.test/bookings/${unpaidBooking.id}/payment`
    );
    expect(html).not.toContain('example.test//bookings');
  });

  it('leaves the link out once the booking is paid', async () => {
    process.env.FRONTEND_URL = 'https://example.test';

    const html = await renderConfirmation({
      ...unpaidBooking,
      payment_status: 'paid',
    });

    expect(html).not.toContain('/payment');
    expect(html).not.toContain('Payment Pending');
  });

  it('renders without a broken link when FRONTEND_URL is unset', async () => {
    delete process.env.FRONTEND_URL;

    const html = await renderConfirmation(unpaidBooking);

    expect(html).not.toContain('undefined/bookings');
    expect(html).toContain('Payment Pending');
  });
});
