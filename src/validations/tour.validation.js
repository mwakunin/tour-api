import { z } from 'zod';
import { urlSchema, slugSchema, booleanQueryParam } from './common.js';

// ============= PRICING SCHEMAS =============

/**
 * Normalize any date-ish value to a YYYY-MM-DD key.
 *
 * Pricing periods store plain date strings, but bookingCreateSchema coerces
 * start_date to a Date, so both shapes reach the resolver. Comparing the
 * normalized keys as strings is correct for ISO dates and — unlike
 * `new Date(iso)` followed by `setHours(0,0,0,0)` — cannot shift the day in
 * timezones behind UTC, which is what makes the period boundaries exact.
 */
export const toDateKey = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

/**
 * `price_per_person` is the price the customer is CHARGED — nothing multiplies
 * it. `compare_at_price` is the optional struck-through "was" figure used for
 * display only; its presence is what puts a tier on offer. Percent-off and
 * savings are derived from the pair (see getTierSavings).
 */
export const pricingTierSchema = z
  .object({
    pax: z.number().int().min(1).max(20),
    price_per_person: z.number().positive(),
    compare_at_price: z.number().positive().optional(),
    total: z.number().positive().optional(),
    currency: z.enum(['USD', 'KES']).default('USD'),
  })
  .refine(
    (data) =>
      data.compare_at_price === undefined ||
      data.compare_at_price > data.price_per_person,
    {
      message:
        'Was-price must be higher than the price you charge, otherwise there is no saving to show',
      path: ['compare_at_price'],
    }
  );

export const pricingPeriodSchema = z
  .object({
    label: z.string().max(100).optional(), // e.g. "Low Season", "Festive Season"
    start_date: z.string().date('Must be a valid YYYY-MM-DD date'),
    end_date: z.string().date('Must be a valid YYYY-MM-DD date'),
    pricing_tiers: z
      .array(pricingTierSchema)
      .min(1, 'At least one pricing tier is required per period'),
  })
  .refine((data) => toDateKey(data.end_date) >= toDateKey(data.start_date), {
    message: 'Period end date must be on or after start date',
    path: ['end_date'],
  });

export const pricingPeriodsSchema = z.array(pricingPeriodSchema).refine(
  (periods) => {
    // Reject overlapping periods — ambiguous pricing is worse than no pricing
    const sorted = [...periods].sort((a, b) =>
      toDateKey(a.start_date).localeCompare(toDateKey(b.start_date))
    );
    for (let i = 1; i < sorted.length; i++) {
      if (
        toDateKey(sorted[i].start_date) <= toDateKey(sorted[i - 1].end_date)
      ) {
        return false;
      }
    }
    return true;
  },
  { message: 'Pricing periods must not overlap' }
);

/**
 * Flat base pricing, for products without seasonal periods.
 *
 * `amount` is charged as entered; `compare_at_amount` is the optional "was"
 * figure. `discount_percentage` is still accepted so older clients don't break,
 * but it is IGNORED — the stored value is derived server-side from the
 * compare-at prices so it can never drift from them.
 */
export const tourPricingSchema = z
  .object({
    amount: z.number().positive('Price must be positive'),
    currency: z.enum(['USD', 'KES']),
    compare_at_amount: z.number().positive().optional(),
    discount_percentage: z.number().min(0).max(100).optional(),
  })
  .refine(
    (data) =>
      data.compare_at_amount === undefined ||
      data.compare_at_amount > data.amount,
    {
      message:
        'Was-price must be higher than the price you charge, otherwise there is no saving to show',
      path: ['compare_at_amount'],
    }
  );

// Itinerary item schema (unchanged)
export const itineraryItemSchema = z.object({
  day: z.string().min(1, 'Day is required'),
  title: z.string().min(1, 'Title is required').max(200),
  activities: z.string().min(1, 'Activities are required'),
  accommodation: z.string().optional(),
  meals: z.string().optional(),
});

// ============= MAIN TOUR SCHEMA =============

export const tourSchema = z
  .object({
    id: z.string().uuid().optional(),
    title: z.string().min(1, 'Title is required').max(200),
    slug: slugSchema,
    overview: z
      .string()
      .min(100, 'Overview must be at least 100 characters')
      .max(5000),

    // Itinerary
    itinerary: z.array(itineraryItemSchema).default([]),

    // Destinations
    destination_ids: z
      .array(z.string().uuid())
      .max(10, 'Maximum 10 destinations allowed')
      .default([]),

    // Tour details
    duration: z.number().int().positive('Duration must be positive'),
    duration_unit: z.enum(['hours', 'days', 'weeks']).default('days'),

    // Pricing — a tour carries either seasonal periods or a flat base price.
    // Flat-priced products (transfers, day trips) have no periods; seasonal
    // tours price off the period covering the travel date and leave the flat
    // columns null. The cross-field refine below enforces "at least one".
    pricing: tourPricingSchema.optional(),

    pricing_periods: pricingPeriodsSchema.optional().default([]),

    // Features
    featured: z.boolean().default(false),
    is_deal: z.boolean().default(false),

    // Media
    images: z
      .array(urlSchema)
      .min(1, 'At least one image required')
      .max(10, 'Maximum 10 images allowed'),
    cover_image: urlSchema.optional(),

    // What's included/excluded
    includes: z.array(z.string().max(500)).default([]),
    excludes: z.array(z.string().max(500)).default([]),

    // Requirements
    requirements: z.string().max(2000).optional(),
    age_restriction: z
      .object({
        min_age: z.number().int().min(0).optional(),
        max_age: z.number().int().max(120).optional(),
      })
      .optional(),

    // Categorization
    tags: z.array(z.string().max(50)).default([]),
    categories: z
      .array(
        z.enum([
          'adventure',
          'cultural',
          'wildlife',
          'beach',
          'luxury',
          'budget',
          'family',
          'honeymoon',
          'group',
          'private',
        ])
      )
      .max(5, 'Maximum 5 categories allowed')
      .default([]),

    // Status
    status: z.enum(['draft', 'published', 'archived']).default('draft'),

    // SEO
    meta_title: z.string().max(60).optional(),
    meta_description: z.string().max(160).optional(),

    // Timestamps
    created_at: z.date().optional(),
    updated_at: z.date().optional(),
  })
  .refine(
    (data) => {
      const hasPeriods =
        Array.isArray(data.pricing_periods) && data.pricing_periods.length > 0;
      const hasFlatPrice =
        data.pricing?.amount !== undefined && data.pricing?.amount !== null;
      return hasPeriods || hasFlatPrice;
    },
    {
      message: 'A tour needs either pricing periods or a flat base price',
      path: ['pricing_periods'],
    }
  )
  .refine(
    (data) => {
      // Presence, not truthiness. min_age 0 is a legitimate value and a
      // falsy one, so `min_age && max_age` skipped the comparison entirely
      // and { min_age: 0, max_age: -1 } passed straight through to the insert.
      const { min_age, max_age } = data.age_restriction ?? {};
      if (min_age !== undefined && max_age !== undefined) {
        return min_age < max_age;
      }
      return true;
    },
    {
      message: 'Min age must be less than max age',
      path: ['age_restriction'],
    }
  );

// ============= HELPER FUNCTIONS =============

/**
 * The saving on a single tier (or a flat {amount, compare_at_amount} pair).
 * Returns null when there is no compare-at price, i.e. the item is not on offer.
 *
 * This is the ONLY place the percent-off arithmetic lives — every badge,
 * strikethrough and "Save X" figure derives from it.
 */

export const getTierSavings = (tier) => {
  if (!tier) return null;

  const charged = tier.price_per_person ?? tier.amount;
  const compareAt = tier.compare_at_price ?? tier.compare_at_amount;

  if (
    charged === null ||
    charged === undefined ||
    compareAt === null ||
    compareAt === undefined
  ) {
    return null;
  }

  const chargedNum = parseFloat(charged);
  const compareNum = parseFloat(compareAt);

  if (
    Number.isNaN(chargedNum) ||
    Number.isNaN(compareNum) ||
    compareNum <= chargedNum
  ) {
    return null;
  }

  return {
    charged: chargedNum,
    compare_at: compareNum,
    saved: compareNum - chargedNum,
    percent_off: Math.round(((compareNum - chargedNum) / compareNum) * 100),
  };
};

/**
 * The tour's headline discount: the biggest saving offered anywhere across its
 * periods, or on its flat price. Written into tours.discount_percentage on
 * create/update.
 *
 * NOTE: this is a write-time summary across ALL seasons, expired ones included,
 * so it can name a promo nobody can still book. The deals endpoint therefore
 * does NOT read it — getDeals computes eligibility and ranking fresh from
 * unexpired seasons (see hasLiveSeasonalOffer / liveDiscountPercent in
 * tour.service.js) and overrides this value in the response. Treat the column
 * as a coarse indicator for admin listings, not as deals truth.
 */
export const computeHeadlineDiscount = (tour) => {
  const periods = Array.isArray(tour?.pricing_periods)
    ? tour.pricing_periods
    : [];

  const percentages = periods.flatMap((period) =>
    (period.pricing_tiers ?? [])
      .map((tier) => getTierSavings(tier)?.percent_off)
      .filter((p) => typeof p === 'number')
  );

  const flat = getTierSavings({
    amount: tour?.amount ?? tour?.price_amount,
    compare_at_amount: tour?.compare_at_amount,
  });
  if (flat) percentages.push(flat.percent_off);

  return percentages.length > 0 ? Math.max(...percentages) : 0;
};

/**
 * @deprecated Prices are now charged as entered — this returns the amount
 * unchanged. Kept so existing callers and the `discounted_price` response
 * field keep working.
 */
export const getDiscountedPrice = (pricing) => {
  if (pricing.amount === null || pricing.amount === undefined) {
    return null;
  }
  return pricing.amount;
};

/**
 * Finds the pricing period covering a given travel start date.
 * Returns null if no period covers it — caller should reject the booking
 * and direct the customer to request a custom quote.
 */
export const resolvePricingPeriod = (pricing_periods, startDate) => {
  if (!Array.isArray(pricing_periods) || pricing_periods.length === 0) {
    return null;
  }

  const target = toDateKey(startDate);
  if (!target) return null;

  return (
    pricing_periods.find((period) => {
      const start = toDateKey(period.start_date);
      const end = toDateKey(period.end_date);
      if (!start || !end) return false;
      // Inclusive on both ends — a trip starting exactly on start_date or
      // end_date is covered by that period.
      return target >= start && target <= end;
    }) || null
  );
};

/**
 * Picks the tier a group of `groupSize` pays within a single period.
 *
 * Exact pax match wins. Otherwise the closest tier at-or-below applies, so a
 * group of 3 against 1/2/4/6 tiers pays the 2-pax rate. Groups smaller than
 * the smallest tier fall back to that smallest tier.
 *
 * Returns the index alongside the tier because booking is server-authoritative:
 * a client-supplied selected_tier_index must match what this resolves to.
 */
export const resolveTierForGroupSize = (period, groupSize) => {
  const tiers = Array.isArray(period?.pricing_tiers)
    ? period.pricing_tiers
    : [];
  if (tiers.length === 0) return null;

  const exact = tiers.findIndex((t) => t.pax === groupSize);
  if (exact !== -1) {
    return { tier: tiers[exact], index: exact, exact_match: true };
  }

  // Closest tier at or below the group size
  let best = -1;
  tiers.forEach((t, i) => {
    if (t.pax <= groupSize && (best === -1 || t.pax > tiers[best].pax)) {
      best = i;
    }
  });

  // Group is smaller than every tier — charge the smallest tier's rate
  if (best === -1) {
    tiers.forEach((t, i) => {
      if (best === -1 || t.pax < tiers[best].pax) best = i;
    });
  }

  return { tier: tiers[best], index: best, exact_match: false };
};

/**
 * Resolve the price for a given group size and travel start date.
 * Returns null if no pricing period covers that date (customer should
 * be directed to request a custom quote).
 */
export const getPriceForGroupSize = (tour, pax, startDate) => {
  const periods = Array.isArray(tour.pricing_periods)
    ? tour.pricing_periods
    : [];

  // Flat-priced tour — no seasonal structure
  if (periods.length === 0) {
    if (!tour.price_amount) return null;
    // Charged as entered — no discount multiplication
    const pricePerPerson = parseFloat(tour.price_amount);
    return {
      price_per_person: pricePerPerson,
      total: pricePerPerson * pax,
      currency: tour.price_currency,
      savings: getTierSavings({
        amount: pricePerPerson,
        compare_at_amount: tour.compare_at_amount,
      }),
      period: null,
      tier_index: null,
      exact_tier_match: false,
    };
  }

  const period = resolvePricingPeriod(periods, startDate);
  if (!period) return null;

  const resolved = resolveTierForGroupSize(period, pax);
  if (!resolved) return null;

  const pricePerPerson = resolved.tier.price_per_person;

  return {
    price_per_person: pricePerPerson,
    total: pricePerPerson * pax,
    currency: resolved.tier.currency,
    savings: getTierSavings(resolved.tier),
    period: {
      label: period.label,
      start_date: period.start_date,
      end_date: period.end_date,
    },
    tier_index: resolved.index,
    exact_tier_match: resolved.exact_match,
  };
};
/**
 * The currency a tour actually displays in.
 *
 * Period-only tours have a null price_currency (the flat columns are unused),
 * so the currency has to come from the tiers — otherwise a USD-priced seasonal
 * tour renders with the KSh fallback symbol.
 */
export const getDisplayCurrency = (tour) => {
  if (tour.price_currency) return tour.price_currency;

  const periods = Array.isArray(tour.pricing_periods)
    ? tour.pricing_periods
    : [];

  for (const period of periods) {
    const tiers = Array.isArray(period.pricing_tiers)
      ? period.pricing_tiers
      : [];
    const withCurrency = tiers.find((t) => t.currency);
    if (withCurrency) return withCurrency.currency;
  }

  return null;
};

/**
 * Card/listing "from" price. Uses the pricing period covering today,
 * falling back to the next upcoming period if today isn't covered
 * (e.g. between seasons, or before the first defined period).
 */
export const getPriceDisplay = (tour) => {
  const periods = Array.isArray(tour.pricing_periods)
    ? tour.pricing_periods
    : [];

  // No seasonal pricing — fall back to the tour's flat price
  if (periods.length === 0) {
    const symbol = tour.price_currency === 'USD' ? '$' : 'KSh';
    const price = parseFloat(tour.price_amount || 0);
    return `${symbol}${price.toFixed(2)}`;
  }

  const today = toDateKey(new Date());

  // Prefer the period covering today; otherwise the soonest upcoming one
  const current = resolvePricingPeriod(periods, today);
  const upcoming = [...periods]
    .filter((p) => toDateKey(p.start_date) >= today)
    .sort((a, b) =>
      toDateKey(a.start_date).localeCompare(toDateKey(b.start_date))
    )[0];

  const period = current || upcoming || periods[periods.length - 1];

  const periodTiers = Array.isArray(period?.pricing_tiers)
    ? period.pricing_tiers
    : [];

  if (periodTiers.length === 0) return null;

  const lowestTier = periodTiers.reduce((min, tier) =>
    parseFloat(tier.price_per_person) < parseFloat(min.price_per_person)
      ? tier
      : min
  );

  const symbol = lowestTier.currency === 'USD' ? '$' : 'KSh';
  const price = parseFloat(lowestTier.price_per_person);

  return `From ${symbol}${price.toFixed(2)} per person`;
};

/**
 * Full price range across every pricing period — lowest per-person price
 * anywhere in the year, to the highest. Gives travelers the complete
 * picture rather than a single season's snapshot.
 */
export const getPriceRangeDisplay = (pricing_periods) => {
  const periods = Array.isArray(pricing_periods) ? pricing_periods : [];

  const tiers = periods.flatMap((p) =>
    Array.isArray(p.pricing_tiers) ? p.pricing_tiers : []
  );

  if (tiers.length === 0) {
    return null;
  }

  // Charged prices as entered — nothing to multiply
  //const prices = tiers.map((t) => t.price_per_person);
  const prices = tiers.map((t) => parseFloat(t.price_per_person));

  const min = Math.min(...prices);
  const max = Math.max(...prices);

  const symbol = tiers[0].currency === 'USD' ? '$' : 'KSh';

  if (min === max) {
    return `${symbol}${min.toFixed(2)} per person`;
  }

  return `${symbol}${min.toFixed(2)} – ${symbol}${max.toFixed(2)} per person`;
};

/**
 * Human-readable date range for a single pricing period.
 * e.g. "1 Jul – 22 Dec 2026" or "23 Dec 2026 – 2 Jan 2027"
 */
export const getPeriodDisplay = (period) => {
  if (!period?.start_date || !period?.end_date) return null;

  const fmt = (iso) =>
    new Date(iso).toLocaleDateString('en-GB', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

  const base = `${fmt(period.start_date)} – ${fmt(period.end_date)}`;
  return period.label ? `${base} (${period.label})` : base;
};

/**
 * Whether a tour has any pricing period covering today or later —
 * replaces the old isTourCurrentlyValid month-based check.
 */
export const isTourCurrentlyBookable = (pricing_periods) => {
  const periods = Array.isArray(pricing_periods) ? pricing_periods : [];
  if (periods.length === 0) return true; // flat-priced tours are always bookable

  const today = toDateKey(new Date());

  return periods.some((p) => toDateKey(p.end_date) >= today);
};

export const getGroupSizeRange = (pricing_periods) => {
  const periods = Array.isArray(pricing_periods) ? pricing_periods : [];

  const paxValues = periods.flatMap((p) =>
    Array.isArray(p.pricing_tiers) ? p.pricing_tiers.map((t) => t.pax) : []
  );

  if (paxValues.length === 0) {
    return { min: 1, max: null };
  }

  return {
    min: Math.min(...paxValues),
    max: Math.max(...paxValues),
  };
};

// Validation helpers
// tourCreateSchema, not tourSchema: tourSchema declares id, created_at and
// updated_at as optional inputs, and createTour spreads the validated object
// straight into the insert — so a caller could pick a new tour's primary key
// and a repeat produced a unique-violation 500 instead of a validation error.
// tourCreateSchema omits those three and carries the same pricing refinement.
export const validateTour = (data) => tourCreateSchema.parse(data);
export const validateTourUpdate = (data) => tourUpdateSchema.parse(data);

// Partial schemas for updates
export const tourUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  slug: slugSchema.optional(),
  overview: z.string().min(100).max(5000).optional(),
  itinerary: z.array(itineraryItemSchema).optional(),
  destination_ids: z.array(z.string().uuid()).max(10).optional(),
  duration: z.number().int().positive().optional(),
  duration_unit: z.enum(['hours', 'days', 'weeks']).optional(),
  pricing: tourPricingSchema.optional(),
  pricing_periods: pricingPeriodsSchema.optional(),
  featured: z.boolean().optional(),
  is_deal: z.boolean().optional(),
  images: z.array(urlSchema).min(1).max(10).optional(),
  cover_image: urlSchema.optional(),
  includes: z.array(z.string().max(500)).optional(),
  excludes: z.array(z.string().max(500)).optional(),
  requirements: z.string().max(2000).optional(),
  age_restriction: z
    .object({
      min_age: z.number().int().min(0).optional(),
      max_age: z.number().int().max(120).optional(),
    })
    .optional(),
  tags: z.array(z.string().max(50)).optional(),
  categories: z
    .array(
      z.enum([
        'adventure',
        'cultural',
        'wildlife',
        'beach',
        'luxury',
        'budget',
        'family',
        'honeymoon',
        'group',
        'private',
      ])
    )
    .max(5)
    .optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  meta_title: z.string().max(60).optional(),
  meta_description: z.string().max(160).optional(),
});

export const tourCreateSchema = z
  .object({
    title: z.string().min(1, 'Title is required').max(200),
    slug: slugSchema,
    overview: z
      .string()
      .min(100, 'Overview must be at least 100 characters')
      .max(5000),
    itinerary: z.array(itineraryItemSchema).default([]),
    destination_ids: z.array(z.string().uuid()).max(10).default([]),
    duration: z.number().int().positive('Duration must be positive'),
    duration_unit: z.enum(['hours', 'days', 'weeks']).default('days'),
    pricing: tourPricingSchema.optional(),
    pricing_periods: pricingPeriodsSchema.optional().default([]),
    featured: z.boolean().default(false),
    is_deal: z.boolean().default(false),
    images: z.array(urlSchema).min(1).max(10),
    cover_image: urlSchema.optional(),
    includes: z.array(z.string().max(500)).default([]),
    excludes: z.array(z.string().max(500)).default([]),
    requirements: z.string().max(2000).optional(),
    age_restriction: z
      .object({
        min_age: z.number().int().min(0).optional(),
        max_age: z.number().int().max(120).optional(),
      })
      .optional(),
    tags: z.array(z.string().max(50)).default([]),
    categories: z
      .array(
        z.enum([
          'adventure',
          'cultural',
          'wildlife',
          'beach',
          'luxury',
          'budget',
          'family',
          'honeymoon',
          'group',
          'private',
        ])
      )
      .max(5)
      .default([]),
    status: z.enum(['draft', 'published', 'archived']).default('draft'),
    meta_title: z.string().max(60).optional(),
    meta_description: z.string().max(160).optional(),
  })
  .refine(
    (data) => {
      const hasPeriods =
        Array.isArray(data.pricing_periods) && data.pricing_periods.length > 0;
      const hasFlatPrice =
        data.pricing?.amount !== undefined && data.pricing?.amount !== null;
      return hasPeriods || hasFlatPrice;
    },
    {
      message: 'A tour needs either pricing periods or a flat base price',
      path: ['pricing_periods'],
    }
  )
  // tourSchema carried this alongside the pricing rule. Moving validateTour
  // onto tourCreateSchema kept the pricing refinement and silently dropped
  // this one, so create accepted min_age 40 with max_age 10 and stored the
  // inverted range. Create is the only path that ever checked it --
  // tourUpdateSchema never had it.
  .refine(
    (data) => {
      // Presence, not truthiness. min_age 0 is a legitimate value and a
      // falsy one, so `min_age && max_age` skipped the comparison entirely
      // and { min_age: 0, max_age: -1 } passed straight through to the insert.
      const { min_age, max_age } = data.age_restriction ?? {};
      if (min_age !== undefined && max_age !== undefined) {
        return min_age < max_age;
      }
      return true;
    },
    {
      message: 'Min age must be less than max age',
      path: ['age_restriction'],
    }
  );

// Query schema (for filtering)
export const tourQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
  status: z.enum(['draft', 'published', 'archived']).optional(),

  // ✅ ADD THIS: Single category filter
  category: z.string().optional(),
  categories: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((val) => (typeof val === 'string' ? [val] : val)),
  destination_ids: z
    .union([z.string().uuid(), z.array(z.string().uuid())])
    .optional()
    .transform((val) => (typeof val === 'string' ? [val] : val)),
  featured: booleanQueryParam,
  is_deal: booleanQueryParam,
  min_price: z.coerce.number().positive().optional(),
  max_price: z.coerce.number().positive().optional(),
  min_duration: z.coerce.number().int().positive().optional(),
  max_duration: z.coerce.number().int().positive().optional(),
  duration_unit: z.enum(['hours', 'days', 'weeks']).optional(),
  search: z.string().max(200).optional(),
  date: z.string().optional(),
  sort_by: z
    .enum(['created_at', 'price', 'title', 'duration', 'featured'])
    .default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export const validateTourQuery = (data) => {
  return tourQuerySchema.parse(data);
};
