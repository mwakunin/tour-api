// The invoice letterhead used to be hardcoded "FOOTLOOSE ADVENTURES" —
// operator #1's name on operator #2's invoices. The caller (email.service)
// now resolves the operator identity from the tenant row and passes it in;
// these tests pin that the passed identity, not a baked constant, wins.
import { generateInvoicePDF } from '#utils/invoiceGenerator.js';

const booking = {
  booking_reference: 'TEST-INV-1',
  created_at: new Date('2026-01-15T10:00:00Z'),
  payment_status: 'paid',
  customer_name: 'Jane Customer',
  customer_email: 'jane@example.com',
  customer_phone: '+254 711 222 333',
  country: 'Kenya',
  group_size: 2,
  start_date: new Date('2026-02-01T10:00:00Z'),
  end_date: new Date('2026-02-05T10:00:00Z'),
  total_price: '2000.00',
  price_per_person: '1000.00',
  currency: 'KES',
  status: 'confirmed',
  tour: { title: 'Mara Expedition' },
};

// jsPDF writes content streams uncompressed, so drawn text is findable in the
// binary output with a latin1 read.
const pdfText = (buffer) => buffer.toString('latin1');

describe('invoice letterhead branding', () => {
  it('prints the operator identity passed by the caller', () => {
    const pdf = generateInvoicePDF(booking, {
      name: 'Zephyr Safaris',
      email: 'hello@zephyr.example',
      phone: '+254 700 111 222',
      addressLine1: 'P.O. Box 999',
      addressLine2: 'Nakuru, Kenya',
      tagline: 'Off-grid Expeditions',
      website: 'www.zephyr.example',
    });
    const text = pdfText(pdf);

    expect(text).toContain('ZEPHYR SAFARIS');
    expect(text).toContain('Zephyr Safaris');
    expect(text).toContain('Off-grid Expeditions');
    expect(text).toContain('hello@zephyr.example');
    expect(text).toContain('www.zephyr.example');
    expect(text).not.toContain('FOOTLOOSE');
  });

  it('keeps the deployment defaults when called without an operator', () => {
    const pdf = generateInvoicePDF(booking);
    const text = pdfText(pdf);

    expect(text).toContain('FOOTLOOSE ADVENTURES');
    expect(text).toContain('Unforgettable Safari Experiences');
  });
});
