import { describe, it, expect } from '@jest/globals';
import {
  tourCreateSchema,
  tourQuerySchema,
  pricingTierSchema,
  pricingPeriodSchema,
  pricingPeriodsSchema,
  getPriceForGroupSize,
  getPriceDisplay,
  getPriceRangeDisplay,
  getGroupSizeRange,
  getDisplayCurrency,
  getTierSavings,
  computeHeadlineDiscount,
  resolvePricingPeriod,
  resolveTierForGroupSize,
  isTourCurrentlyBookable,
} from '../../validations/tour.validation.js';
import { mpesaCallbackSchema } from '../../validations/payment.validation.js';

describe('Tour Validation Schemas', () => {
  describe('pricingTierSchema', () => {
    it('should validate a valid pricing tier', () => {
      const validTier = {
        pax: 2,
        price_per_person: 800,
        total: 1600,
        currency: 'USD',
      };

      expect(() => pricingTierSchema.parse(validTier)).not.toThrow();
    });

    it('should reject negative pax', () => {
      const invalidTier = {
        pax: -1,
        price_per_person: 800,
        total: -800,
        currency: 'USD',
      };

      expect(() => pricingTierSchema.parse(invalidTier)).toThrow();
    });

    it('should accept a tier without a total', () => {
      // total is derived, not authoritative — the server prices off
      // price_per_person × group_size
      const tierWithoutTotal = {
        pax: 2,
        price_per_person: 800,
        currency: 'USD',
      };

      expect(() => pricingTierSchema.parse(tierWithoutTotal)).not.toThrow();
    });

    it('should reject invalid currency', () => {
      const invalidTier = {
        pax: 2,
        price_per_person: 800,
        total: 1600,
        currency: 'GBP', // Not supported
      };

      expect(() => pricingTierSchema.parse(invalidTier)).toThrow();
    });
  });

  describe('pricingPeriodSchema', () => {
    const tiers = [{ pax: 2, price_per_person: 800, currency: 'USD' }];

    it('should validate a valid pricing period', () => {
      const validPeriod = {
        label: 'High Season',
        start_date: '2026-07-01',
        end_date: '2026-09-30',
        pricing_tiers: tiers,
      };

      expect(() => pricingPeriodSchema.parse(validPeriod)).not.toThrow();
    });

    it('should accept a period spanning a year boundary', () => {
      const festive = {
        label: 'Festive Season',
        start_date: '2026-12-23',
        end_date: '2027-01-02',
        pricing_tiers: tiers,
      };

      expect(() => pricingPeriodSchema.parse(festive)).not.toThrow();
    });

    it('should accept a single-day period', () => {
      const oneDay = {
        start_date: '2026-07-01',
        end_date: '2026-07-01',
        pricing_tiers: tiers,
      };

      expect(() => pricingPeriodSchema.parse(oneDay)).not.toThrow();
    });

    it('should reject a malformed date', () => {
      const invalid = {
        start_date: '01/07/2026',
        end_date: '2026-09-30',
        pricing_tiers: tiers,
      };

      expect(() => pricingPeriodSchema.parse(invalid)).toThrow();
    });

    it('should reject when end date is before start date', () => {
      const invalid = {
        start_date: '2026-09-30',
        end_date: '2026-07-01',
        pricing_tiers: tiers,
      };

      expect(() => pricingPeriodSchema.parse(invalid)).toThrow();
    });

    it('should reject a period with no pricing tiers', () => {
      const invalid = {
        start_date: '2026-07-01',
        end_date: '2026-09-30',
        pricing_tiers: [],
      };

      expect(() => pricingPeriodSchema.parse(invalid)).toThrow();
    });
  });

  describe('pricingPeriodsSchema', () => {
    const tiers = [{ pax: 2, price_per_person: 800, currency: 'USD' }];
    const period = (start_date, end_date) => ({
      start_date,
      end_date,
      pricing_tiers: tiers,
    });

    it('should accept non-overlapping periods', () => {
      const periods = [
        period('2026-01-01', '2026-06-30'),
        period('2026-07-01', '2026-12-31'),
      ];

      expect(() => pricingPeriodsSchema.parse(periods)).not.toThrow();
    });

    it('should accept non-overlapping periods given out of order', () => {
      const periods = [
        period('2026-07-01', '2026-12-31'),
        period('2026-01-01', '2026-06-30'),
      ];

      expect(() => pricingPeriodsSchema.parse(periods)).not.toThrow();
    });

    it('should reject overlapping periods', () => {
      const periods = [
        period('2026-01-01', '2026-07-15'),
        period('2026-07-01', '2026-12-31'),
      ];

      expect(() => pricingPeriodsSchema.parse(periods)).toThrow(
        /must not overlap/
      );
    });

    it('should reject periods that touch on the same day', () => {
      // Both ends are inclusive, so a shared day is genuinely ambiguous
      const periods = [
        period('2026-01-01', '2026-06-30'),
        period('2026-06-30', '2026-12-31'),
      ];

      expect(() => pricingPeriodsSchema.parse(periods)).toThrow(
        /must not overlap/
      );
    });

    it('should accept an empty array', () => {
      expect(() => pricingPeriodsSchema.parse([])).not.toThrow();
    });
  });

  describe('resolvePricingPeriod', () => {
    const tiers = [{ pax: 2, price_per_person: 800, currency: 'USD' }];
    const periods = [
      {
        label: 'Low Season',
        start_date: '2026-01-10',
        end_date: '2026-03-31',
        pricing_tiers: tiers,
      },
      {
        label: 'High Season',
        start_date: '2026-07-01',
        end_date: '2026-09-30',
        pricing_tiers: tiers,
      },
      {
        label: 'Festive Season',
        start_date: '2026-12-23',
        end_date: '2027-01-02',
        pricing_tiers: tiers,
      },
    ];

    const labelFor = (date) =>
      resolvePricingPeriod(periods, date)?.label ?? null;

    it('should match a date inside a period', () => {
      expect(labelFor('2026-02-15')).toBe('Low Season');
    });

    it('should match a date exactly on a period start date', () => {
      expect(labelFor('2026-01-10')).toBe('Low Season');
      expect(labelFor('2026-07-01')).toBe('High Season');
    });

    it('should match a date exactly on a period end date', () => {
      expect(labelFor('2026-03-31')).toBe('Low Season');
      expect(labelFor('2026-09-30')).toBe('High Season');
    });

    it('should return null for a date in a gap between periods', () => {
      expect(labelFor('2026-05-15')).toBeNull();
      // One day either side of the gap boundaries
      expect(labelFor('2026-04-01')).toBeNull();
      expect(labelFor('2026-06-30')).toBeNull();
    });

    it('should return null for a date before every period', () => {
      expect(labelFor('2026-01-09')).toBeNull();
      expect(labelFor('2020-01-01')).toBeNull();
    });

    it('should return null for a date after every period', () => {
      expect(labelFor('2027-01-03')).toBeNull();
      expect(labelFor('2030-06-01')).toBeNull();
    });

    it('should match across a year boundary', () => {
      expect(labelFor('2026-12-23')).toBe('Festive Season');
      expect(labelFor('2026-12-31')).toBe('Festive Season');
      expect(labelFor('2027-01-01')).toBe('Festive Season');
      expect(labelFor('2027-01-02')).toBe('Festive Season');
    });

    it('should accept a Date object as well as a string', () => {
      expect(labelFor(new Date('2026-02-15'))).toBe('Low Season');
      // Boundary dates must survive the Date round-trip too
      expect(labelFor(new Date('2026-01-10'))).toBe('Low Season');
      expect(labelFor(new Date('2026-03-31'))).toBe('Low Season');
    });

    it('should ignore the time component of a datetime', () => {
      expect(labelFor('2026-03-31T23:30:00Z')).toBe('Low Season');
    });

    it('should return null for empty or missing input', () => {
      expect(resolvePricingPeriod([], '2026-02-15')).toBeNull();
      expect(resolvePricingPeriod(null, '2026-02-15')).toBeNull();
      expect(resolvePricingPeriod(undefined, '2026-02-15')).toBeNull();
      expect(resolvePricingPeriod(periods, null)).toBeNull();
      expect(resolvePricingPeriod(periods, 'not-a-date')).toBeNull();
    });
  });

  describe('resolveTierForGroupSize', () => {
    // Deliberately unsorted to prove the resolver does not assume ordering
    const period = {
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      pricing_tiers: [
        { pax: 1, price_per_person: 1000, currency: 'USD' },
        { pax: 4, price_per_person: 600, currency: 'USD' },
        { pax: 2, price_per_person: 800, currency: 'USD' },
        { pax: 6, price_per_person: 500, currency: 'USD' },
      ],
    };

    it('should pick the exact tier when the group size matches', () => {
      const result = resolveTierForGroupSize(period, 4);
      expect(result.tier.pax).toBe(4);
      expect(result.tier.price_per_person).toBe(600);
      expect(result.index).toBe(1);
      expect(result.exact_match).toBe(true);
    });

    it('should use the closest tier at or below for an in-between group', () => {
      // A group of 3 against 1/2/4/6 pays the 2-pax rate
      const result = resolveTierForGroupSize(period, 3);
      expect(result.tier.pax).toBe(2);
      expect(result.tier.price_per_person).toBe(800);
      expect(result.exact_match).toBe(false);
    });

    it('should use the largest tier for a group above every tier', () => {
      const result = resolveTierForGroupSize(period, 9);
      expect(result.tier.pax).toBe(6);
      expect(result.exact_match).toBe(false);
    });

    it('should use the smallest tier for a group below every tier', () => {
      const smallest = {
        pricing_tiers: [
          { pax: 4, price_per_person: 600, currency: 'USD' },
          { pax: 2, price_per_person: 800, currency: 'USD' },
        ],
      };

      const result = resolveTierForGroupSize(smallest, 1);
      expect(result.tier.pax).toBe(2);
      expect(result.exact_match).toBe(false);
    });

    it('should return null when the period has no tiers', () => {
      expect(resolveTierForGroupSize({ pricing_tiers: [] }, 2)).toBeNull();
      expect(resolveTierForGroupSize({}, 2)).toBeNull();
      expect(resolveTierForGroupSize(null, 2)).toBeNull();
    });
  });

  describe('isTourCurrentlyBookable', () => {
    const tiers = [{ pax: 2, price_per_person: 800, currency: 'USD' }];

    it('should treat flat-priced tours as always bookable', () => {
      expect(isTourCurrentlyBookable([])).toBe(true);
      expect(isTourCurrentlyBookable(null)).toBe(true);
    });

    it('should be true when a period ends in the future', () => {
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];

      expect(
        isTourCurrentlyBookable([
          { start_date: '2020-01-01', end_date: future, pricing_tiers: tiers },
        ])
      ).toBe(true);
    });

    it('should be false when every period is in the past', () => {
      expect(
        isTourCurrentlyBookable([
          {
            start_date: '2020-01-01',
            end_date: '2020-12-31',
            pricing_tiers: tiers,
          },
        ])
      ).toBe(false);
    });
  });

  describe('getGroupSizeRange', () => {
    it('should span tiers across every period', () => {
      const periods = [
        {
          start_date: '2026-01-01',
          end_date: '2026-06-30',
          pricing_tiers: [
            { pax: 2, price_per_person: 800, currency: 'USD' },
            { pax: 4, price_per_person: 600, currency: 'USD' },
          ],
        },
        {
          start_date: '2026-07-01',
          end_date: '2026-12-31',
          pricing_tiers: [{ pax: 8, price_per_person: 500, currency: 'USD' }],
        },
      ];

      expect(getGroupSizeRange(periods)).toEqual({ min: 2, max: 8 });
    });

    it('should return an open range when there are no periods', () => {
      expect(getGroupSizeRange([])).toEqual({ min: 1, max: null });
    });
  });

  describe('getDisplayCurrency', () => {
    it('should use the flat column for flat-priced tours', () => {
      expect(
        getDisplayCurrency({ price_currency: 'KES', pricing_periods: [] })
      ).toBe('KES');
    });

    it('should fall back to the tier currency for period-only tours', () => {
      // price_currency is null for a period-only tour — without the fallback
      // a USD tour would render with the KSh symbol
      const tour = {
        price_currency: null,
        pricing_periods: [
          {
            start_date: '2026-01-01',
            end_date: '2026-12-31',
            pricing_tiers: [{ pax: 2, price_per_person: 800, currency: 'USD' }],
          },
        ],
      };

      expect(getDisplayCurrency(tour)).toBe('USD');
    });

    it('should return null when nothing declares a currency', () => {
      expect(
        getDisplayCurrency({ price_currency: null, pricing_periods: [] })
      ).toBeNull();
    });
  });

  describe('tourCreateSchema', () => {
    it('should validate a complete tour object', () => {
      const validTour = {
        title: 'Maasai Mara Safari',
        slug: 'maasai-mara-safari',
        overview:
          'Experience the breathtaking wildlife of Maasai Mara National Reserve with our expertly guided safari tours. This is a comprehensive overview that meets the minimum length requirement.',
        duration: 5,
        duration_unit: 'days',
        pricing: {
          amount: 1200,
          currency: 'USD',
          discount_percentage: 10,
        },
        images: ['https://example.com/image1.jpg'],
        destination_ids: [],
        featured: false,
        is_deal: false,
      };

      expect(() => tourCreateSchema.parse(validTour)).not.toThrow();
    });

    it('should reject tour with short overview', () => {
      const invalidTour = {
        title: 'Short Tour',
        slug: 'short-tour',
        overview: 'Too short', // Less than 100 characters
        duration: 1,
        pricing: {
          amount: 100,
          currency: 'USD',
        },
        images: ['https://example.com/image1.jpg'],
      };

      expect(() => tourCreateSchema.parse(invalidTour)).toThrow();
    });

    it('should validate tour with pricing periods and no flat price', () => {
      const seasonalTour = {
        title: 'Group Safari',
        slug: 'group-safari',
        overview:
          'A detailed overview of the group safari experience that is long enough to meet validation requirements.',
        duration: 3,
        pricing_periods: [
          {
            label: 'High Season',
            start_date: '2026-07-01',
            end_date: '2026-09-30',
            pricing_tiers: [
              { pax: 2, price_per_person: 800, total: 1600, currency: 'USD' },
              { pax: 4, price_per_person: 600, total: 2400, currency: 'USD' },
            ],
          },
        ],
        images: ['https://example.com/image1.jpg'],
      };

      expect(() => tourCreateSchema.parse(seasonalTour)).not.toThrow();
    });

    it('should reject overlapping pricing periods', () => {
      const overlapping = {
        title: 'Overlapping Tour',
        slug: 'overlapping-tour',
        overview:
          'A detailed overview that meets the minimum length requirement for tour validation.',
        duration: 3,
        pricing_periods: [
          {
            start_date: '2026-01-01',
            end_date: '2026-07-15',
            pricing_tiers: [{ pax: 2, price_per_person: 800, currency: 'USD' }],
          },
          {
            start_date: '2026-07-01',
            end_date: '2026-12-31',
            pricing_tiers: [{ pax: 2, price_per_person: 900, currency: 'USD' }],
          },
        ],
        images: ['https://example.com/image1.jpg'],
      };

      expect(() => tourCreateSchema.parse(overlapping)).toThrow(
        /must not overlap/
      );
    });

    it('should reject a tour with neither periods nor a flat price', () => {
      const unpriced = {
        title: 'Unpriced Tour',
        slug: 'unpriced-tour',
        overview:
          'A detailed overview that meets the minimum length requirement for tour validation.',
        duration: 3,
        images: ['https://example.com/image1.jpg'],
      };

      expect(() => tourCreateSchema.parse(unpriced)).toThrow(
        /either pricing periods or a flat base price/
      );
    });
  });

  describe('tourQuerySchema', () => {
    it('should validate basic query parameters', () => {
      const query = {
        page: '1',
        limit: '10',
        status: 'published',
      };

      const result = tourQuerySchema.parse(query);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.status).toBe('published');
    });

    it('should apply default values', () => {
      const query = {};
      const result = tourQuerySchema.parse(query);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.sort_by).toBe('created_at');
      expect(result.sort_order).toBe('desc');
    });

    it('should transform categories string to array', () => {
      const query = {
        categories: 'wildlife',
      };

      const result = tourQuerySchema.parse(query);
      expect(result.categories).toEqual(['wildlife']);
    });

    it('should reject invalid limit', () => {
      const query = {
        limit: '200', // Exceeds max of 100
      };

      expect(() => tourQuerySchema.parse(query)).toThrow();
    });

    it('should correctly coerce featured=false to boolean false, not true', () => {
      const result = tourQuerySchema.parse({ featured: 'false' });
      expect(result.featured).toBe(false);
    });

    it('should correctly coerce featured=true to boolean true', () => {
      const result = tourQuerySchema.parse({ featured: 'true' });
      expect(result.featured).toBe(true);
    });
  });
});

describe('Tour Utility Functions', () => {
  describe('getPriceForGroupSize', () => {
    // A period covering "now" so the date argument is unambiguous
    const dayMs = 24 * 60 * 60 * 1000;
    const dateKey = (offsetDays) =>
      new Date(Date.now() + offsetDays * dayMs).toISOString().split('T')[0];
    const travelDate = dateKey(30);

    const seasonalTour = (tiers, discount = '0') => ({
      price_amount: null,
      price_currency: null,
      discount_percentage: discount,
      pricing_periods: [
        {
          label: 'Test Season',
          start_date: dateKey(-30),
          end_date: dateKey(365),
          pricing_tiers: tiers,
        },
      ],
    });

    const twoTiers = [
      { pax: 2, price_per_person: 800, total: 1600, currency: 'USD' },
      { pax: 4, price_per_person: 600, total: 2400, currency: 'USD' },
    ];

    it('should return base price when the tour has no periods', () => {
      const tour = {
        price_amount: '1000',
        price_currency: 'USD',
        discount_percentage: '0',
        pricing_periods: [],
      };

      const result = getPriceForGroupSize(tour, 4, travelDate);
      expect(result.price_per_person).toBe(1000);
      expect(result.total).toBe(4000);
      expect(result.currency).toBe('USD');
      expect(result.period).toBeNull();
    });

    it('should charge the base price verbatim, ignoring compare-at', () => {
      const tour = {
        price_amount: '600',
        price_currency: 'USD',
        compare_at_amount: '800',
        pricing_periods: [],
      };

      const result = getPriceForGroupSize(tour, 2, travelDate);
      // The entered price is what is charged — compare-at is display only
      expect(result.price_per_person).toBe(600);
      expect(result.total).toBe(1200);
      expect(result.savings.compare_at).toBe(800);
      expect(result.savings.percent_off).toBe(25);
    });

    it('should return null for a flat-priced tour with no price at all', () => {
      const tour = {
        price_amount: null,
        price_currency: null,
        discount_percentage: '0',
        pricing_periods: [],
      };

      expect(getPriceForGroupSize(tour, 2, travelDate)).toBeNull();
    });

    it('should find exact tier match within the covering period', () => {
      const result = getPriceForGroupSize(
        seasonalTour(twoTiers),
        4,
        travelDate
      );
      expect(result.price_per_person).toBe(600);
      expect(result.total).toBe(2400);
      expect(result.exact_tier_match).toBe(true);
      expect(result.period.label).toBe('Test Season');
    });

    it('should use smallest tier for pax below smallest tier', () => {
      const result = getPriceForGroupSize(
        seasonalTour(twoTiers),
        1,
        travelDate
      );
      expect(result.price_per_person).toBe(800); // Uses smallest tier
      expect(result.total).toBe(800); // 800 * 1
      expect(result.exact_tier_match).toBe(false);
    });

    it('should use largest tier for pax above largest tier', () => {
      const result = getPriceForGroupSize(
        seasonalTour(twoTiers),
        6,
        travelDate
      );
      expect(result.price_per_person).toBe(600); // Uses largest tier
      expect(result.total).toBe(3600); // 600 * 6
    });

    it('should use the closest tier at or below for an in-between group', () => {
      const result = getPriceForGroupSize(
        seasonalTour(twoTiers),
        3,
        travelDate
      );
      expect(result.price_per_person).toBe(800); // 2-pax rate
      expect(result.total).toBe(2400); // 800 * 3
      expect(result.tier_index).toBe(0);
    });

    it('should charge the tier price even when it carries a compare-at', () => {
      // The regression this whole model exists to prevent: the customer pays
      // the entered price, never the compare-at
      const onOffer = [
        {
          pax: 2,
          price_per_person: 600,
          compare_at_price: 800,
          currency: 'USD',
        },
      ];
      const result = getPriceForGroupSize(seasonalTour(onOffer), 2, travelDate);

      expect(result.price_per_person).toBe(600);
      expect(result.total).toBe(1200);
      expect(result.savings.compare_at).toBe(800);
      expect(result.savings.saved).toBe(200);
      expect(result.savings.percent_off).toBe(25);
    });

    it('should report no savings for a tier without a compare-at', () => {
      const result = getPriceForGroupSize(
        seasonalTour(twoTiers),
        4,
        travelDate
      );
      expect(result.price_per_person).toBe(600);
      expect(result.savings).toBeNull();
    });

    it('should return null when no period covers the travel date', () => {
      const result = getPriceForGroupSize(
        seasonalTour(twoTiers),
        4,
        dateKey(500) // beyond the period's end
      );
      expect(result).toBeNull();
    });
  });

  describe('getPriceDisplay', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const dateKey = (offsetDays) =>
      new Date(Date.now() + offsetDays * dayMs).toISOString().split('T')[0];

    it('should format USD price without periods', () => {
      const tour = {
        price_amount: '1000',
        price_currency: 'USD',
        discount_percentage: '0',
        pricing_periods: [],
      };

      expect(getPriceDisplay(tour)).toBe('$1000.00');
    });

    it('should format KES price', () => {
      const tour = {
        price_amount: '50000',
        price_currency: 'KES',
        discount_percentage: '0',
        pricing_periods: [],
      };

      expect(getPriceDisplay(tour)).toBe('KSh50000.00');
    });

    it('should show "from" price using the period covering today', () => {
      const tour = {
        price_amount: null,
        price_currency: null,
        discount_percentage: '0',
        pricing_periods: [
          {
            start_date: dateKey(-10),
            end_date: dateKey(10),
            pricing_tiers: [
              { pax: 2, price_per_person: 800, currency: 'USD' },
              { pax: 4, price_per_person: 600, currency: 'USD' },
            ],
          },
        ],
      };

      const result = getPriceDisplay(tour);
      expect(result).toContain('From');
      expect(result).toContain('$600.00'); // Lowest tier price
    });

    it('should fall back to the next upcoming period between seasons', () => {
      const tour = {
        price_amount: null,
        price_currency: null,
        discount_percentage: '0',
        pricing_periods: [
          {
            start_date: dateKey(60),
            end_date: dateKey(90),
            pricing_tiers: [{ pax: 2, price_per_person: 700, currency: 'USD' }],
          },
        ],
      };

      expect(getPriceDisplay(tour)).toContain('$700.00');
    });

    it('should show the charged price, not the compare-at', () => {
      const tour = {
        price_amount: null,
        price_currency: null,
        pricing_periods: [
          {
            start_date: dateKey(-10),
            end_date: dateKey(10),
            pricing_tiers: [
              {
                pax: 2,
                price_per_person: 600,
                compare_at_price: 1000,
                currency: 'USD',
              },
            ],
          },
        ],
      };

      expect(getPriceDisplay(tour)).toContain('$600.00');
      expect(getPriceDisplay(tour)).not.toContain('$1000.00');
    });
  });

  describe('getTierSavings', () => {
    it('should derive the saving from charged vs compare-at', () => {
      const s = getTierSavings({
        price_per_person: 600,
        compare_at_price: 800,
      });
      expect(s.charged).toBe(600);
      expect(s.compare_at).toBe(800);
      expect(s.saved).toBe(200);
      expect(s.percent_off).toBe(25);
    });

    it('should return null without a compare-at, or when it is not higher', () => {
      expect(getTierSavings({ price_per_person: 600 })).toBeNull();
      expect(
        getTierSavings({ price_per_person: 600, compare_at_price: 600 })
      ).toBeNull();
      expect(
        getTierSavings({ price_per_person: 600, compare_at_price: 500 })
      ).toBeNull();
    });

    it('should work for a flat amount / compare_at_amount pair', () => {
      expect(
        getTierSavings({ amount: 50, compare_at_amount: 100 }).percent_off
      ).toBe(50);
    });
    it('should handle decimal values arriving as strings from the database', () => {
      const s = getTierSavings({
        price_per_person: '900.00',
        compare_at_price: '1000.00',
      });
      expect(s).not.toBeNull();
      expect(s.charged).toBe(900);
      expect(s.compare_at).toBe(1000);
      expect(s.saved).toBe(100);
      expect(s.percent_off).toBe(10);
    });

    it('should return null for values that are not parseable numbers', () => {
      expect(
        getTierSavings({ price_per_person: 'abc', compare_at_price: '1000.00' })
      ).toBeNull();
      expect(
        getTierSavings({ price_per_person: '900.00', compare_at_price: 'xyz' })
      ).toBeNull();
    });
  });

  describe('computeHeadlineDiscount', () => {
    it('should take the largest saving across every period', () => {
      const headline = computeHeadlineDiscount({
        pricing_periods: [
          {
            pricing_tiers: [
              { pax: 2, price_per_person: 900, compare_at_price: 1000 }, // 10%
            ],
          },
          {
            pricing_tiers: [
              { pax: 2, price_per_person: 600, compare_at_price: 800 }, // 25%
              { pax: 4, price_per_person: 500 }, // none
            ],
          },
        ],
      });
      expect(headline).toBe(25);
    });

    it('should be 0 when nothing is on offer', () => {
      expect(
        computeHeadlineDiscount({
          pricing_periods: [
            { pricing_tiers: [{ pax: 2, price_per_person: 600 }] },
          ],
        })
      ).toBe(0);
      expect(computeHeadlineDiscount({})).toBe(0);
    });

    it('should use the flat compare-at for tours without periods', () => {
      expect(
        computeHeadlineDiscount({
          pricing_periods: [],
          amount: 50,
          compare_at_amount: 100,
        })
      ).toBe(50);
    });
    it('should handle string prices from the database', () => {
      expect(
        computeHeadlineDiscount({
          pricing_periods: [
            {
              pricing_tiers: [
                {
                  pax: 2,
                  price_per_person: '900.00',
                  compare_at_price: '1000.00',
                },
              ],
            },
          ],
        })
      ).toBe(10);
    });
  });

  describe('getPriceRangeDisplay', () => {
    const period = (pricing_tiers) => ({
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      pricing_tiers,
    });

    it('should return null when there are no periods', () => {
      expect(getPriceRangeDisplay([])).toBeNull();
      expect(getPriceRangeDisplay(null)).toBeNull();
    });

    it('should show single price when all tiers have same price', () => {
      const periods = [
        period([
          { pax: 2, price_per_person: 800, total: 1600, currency: 'USD' },
          { pax: 4, price_per_person: 800, total: 3200, currency: 'USD' },
        ]),
      ];

      expect(getPriceRangeDisplay(periods, 0)).toBe('$800.00 per person');
    });

    it('should show price range for different tier prices', () => {
      const periods = [
        period([
          { pax: 2, price_per_person: 800, total: 1600, currency: 'USD' },
          { pax: 4, price_per_person: 600, total: 2400, currency: 'USD' },
        ]),
      ];

      expect(getPriceRangeDisplay(periods, 0)).toBe(
        '$600.00 – $800.00 per person'
      );
    });

    it('should span the range across every period', () => {
      const periods = [
        period([{ pax: 2, price_per_person: 500, currency: 'USD' }]),
        {
          start_date: '2027-01-01',
          end_date: '2027-12-31',
          pricing_tiers: [{ pax: 2, price_per_person: 1200, currency: 'USD' }],
        },
      ];

      expect(getPriceRangeDisplay(periods, 0)).toBe(
        '$500.00 – $1200.00 per person'
      );
    });
  });
  describe('Payment Validation Schemas', () => {
    describe('mpesaCallbackSchema', () => {
      it('should validate a real Safaricom-shaped M-Pesa callback payload', () => {
        const realCallbackShape = {
          Body: {
            stkCallback: {
              MerchantRequestID: 'test-merchant-id',
              CheckoutRequestID: 'test-checkout-id',
              ResultCode: 0,
              ResultDesc: 'The service request is processed successfully.',
              CallbackMetadata: {
                Item: [
                  { Name: 'Amount', Value: 1000 },
                  { Name: 'MpesaReceiptNumber', Value: 'ABC123XYZ' },
                ],
              },
            },
          },
        };

        const result = mpesaCallbackSchema.safeParse(realCallbackShape);
        expect(result.success).toBe(true);
      });

      it('should reject the old flat (incorrect) callback shape', () => {
        const flatShape = {
          MerchantRequestID: 'test-merchant-id',
          CheckoutRequestID: 'test-checkout-id',
          ResultCode: 0,
          ResultDesc: 'Success',
        };

        const result = mpesaCallbackSchema.safeParse(flatShape);
        expect(result.success).toBe(false);
      });
    });
  });
});
