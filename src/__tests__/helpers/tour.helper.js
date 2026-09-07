// ============================================
// FILE 4: src/__tests__/helpers/tour.helper.js
// ============================================
import { db } from '#config/database.js';
import { tours } from '#models/tour.model.js';
import { eq } from 'drizzle-orm';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';

/**
 * Create a test tour with a unique slug and title by default.
 * @param {Object} overrides - Optional fields to override the default tour data.
 * @returns {Promise<Object>} The created tour object.
 */
/**
 * Build a pricing period spanning a window around today.
 *
 * Booking fixtures all travel ~30 days out, so the period must be anchored to
 * the current date — a hardcoded calendar year would make resolvePricingPeriod
 * return null and every booking test would fail with "No pricing is available
 * for these travel dates."
 */
export const buildTestPricingPeriod = (overrides = {}) => {
  const dayMs = 24 * 60 * 60 * 1000;
  const key = (offsetDays) =>
    new Date(Date.now() + offsetDays * dayMs).toISOString().split('T')[0];

  return {
    label: 'Test Season',
    start_date: key(-30),
    end_date: key(365),
    pricing_tiers: [
      { pax: 2, price_per_person: 585, total: 1170, currency: 'USD' },
      { pax: 4, price_per_person: 495, total: 1980, currency: 'USD' },
      { pax: 6, price_per_person: 432, total: 2592, currency: 'USD' },
    ],
    ...overrides,
  };
};

export const createTestTour = async (overrides = {}) => {
  // Generate a unique suffix to prevent 'tours_slug_unique' constraint violation
  const uniqueSuffix = Math.random().toString(36).substring(2, 8);
  const defaultTitle = `Test Safari Tour (${uniqueSuffix})`;
  const defaultSlug = `test-safari-tour-${uniqueSuffix}`;

  const tourData = {
    tenant_id: SEED_TENANT_ID,
    title: defaultTitle, // Now unique!
    slug: defaultSlug, // Now unique!
    overview:
      'A test safari tour for integration testing purposes. This tour includes amazing wildlife viewing opportunities.',
    duration: 3,
    duration_unit: 'days',
    price_amount: 1200,
    price_currency: 'USD',
    discount_percentage: 0,
    pricing_periods: [buildTestPricingPeriod()],
    featured: false,
    is_deal: false,
    images: ['https://example.com/image1.jpg'],
    cover_image: 'https://example.com/cover.jpg',
    includes: ['Accommodation', 'Meals'],
    excludes: ['Flights'],
    status: 'published',
    // Apply overrides last, allowing specific tests to intentionally change the slug/title if needed
    ...overrides,
  };

  const [tour] = await db.insert(tours).values(tourData).returning();
  return tour;
};

/**
 * Delete test tour
 * @param {number | string} tourId - The ID of the tour to delete.
 */
export const deleteTestTour = async (tourId) => {
  // Added a check here, although the primary fix should resolve the need for it.
  if (tourId) {
    await db.delete(tours).where(eq(tours.id, tourId));
  }
};
