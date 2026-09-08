// src/middleware/tenant.middleware.js
//
// Puts the current operator into AsyncLocalStorage for the life of the
// request, so every `withTenantDb` call underneath it scopes to that tenant.
//
// It sets no database state on its own — the transaction and the
// `set_config` happen per operation in withTenantDb, because this app makes
// external HTTP calls mid-request and must not hold a connection across them.
//
// RESOLUTION IS OPT-IN, AND OFF BY DEFAULT.
//
// With TENANT_HOST_SUFFIX unset — which is every deployment today — this
// resolves to the seeded operator without touching the database, exactly as it
// did when it was a one-line function. Subdomain routing only switches on when
// somebody names the domain it should apply under, because "first label of the
// hostname" is not a safe rule on its own: it would read `api` out of
// api.footlooseadventures.com and hand the request to whichever operator
// happened to register that slug.

import { eq } from 'drizzle-orm';

import { db } from '#config/database.js';
import { tenants } from '#models/schema.js';
import { runWithTenant } from '#config/tenantContext.js';
import logger from '#config/logger.js';

// Seeded by migration 0007. Also the value of the tenant_id DEFAULT, which is
// why the app behaves identically whether or not a handler has been migrated
// onto the tenant-scoped connection yet.
export const SEED_TENANT_ID = '00000000-0000-0000-0000-000000000001';

const defaultTenantId = () => process.env.SEED_TENANT_ID || SEED_TENANT_ID;

// Hostnames that belong to the deployment rather than to an operator. Reserved
// here rather than left to a UNIQUE constraint on slug, because the damage is
// asymmetric: an operator who registers the slug `api` would otherwise start
// receiving every request aimed at the shared API hostname.
const RESERVED_LABELS = new Set([
  'api',
  'www',
  'app',
  'admin',
  'staging',
  'dashboard',
]);

// Resolution runs before any tenant is set, so `public.current_tenant_id()` is
// NULL and the `tenants_self_only` policy from migration 0008 would return
// zero rows on the runtime connection. Deciding *which* tenant a request
// belongs to is an owner-plane question — it cannot be asked from inside the
// answer — so this is the one lookup that legitimately uses `db` rather than
// appDb. It selects id and status and nothing else.
const CACHE_TTL_MS = 60_000;
const cache = new Map();

// Exported for tests: a lookup cached for a minute otherwise outlives the row
// a test just created.
export const _clearTenantCache = () => cache.clear();

const lookupBySlug = async (slug) => {
  const hit = cache.get(slug);
  if (hit && hit.expires > Date.now()) return hit.tenant;

  const [row] = await db
    .select({ id: tenants.id, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);

  // Negative results are cached too. Without that, a bad hostname — or a
  // scanner walking subdomains — is an uncached database query per request.
  const tenant = row ?? null;
  cache.set(slug, { tenant, expires: Date.now() + CACHE_TTL_MS });
  return tenant;
};

/**
 * The tenant slug a hostname names, or null if it names no operator.
 *
 * Returns null for the apex, for reserved labels and for any host outside the
 * configured suffix — all of which mean "the default operator", not "unknown".
 * A host that IS under the suffix but names nothing valid returns a slug, so
 * the caller can tell those apart and refuse rather than fall back.
 */
export const _slugForHost = (host, suffix) => {
  if (!suffix) return null;

  const normalisedHost = String(host || '')
    .toLowerCase()
    .replace(/\.$/, '');
  const normalisedSuffix = suffix.toLowerCase().replace(/^\./, '');

  if (!normalisedHost || normalisedHost === normalisedSuffix) return null;
  if (!normalisedHost.endsWith(`.${normalisedSuffix}`)) return null;

  const label = normalisedHost.slice(0, -(normalisedSuffix.length + 1));

  // Deeper than one label. Not treated as the default operator: it is under
  // our routing domain, so serving it the seeded tenant's data would be the
  // exact confusion the suffix exists to prevent. Returned as a slug that
  // cannot match any row, so the caller 404s.
  if (label.includes('.')) return label;

  if (RESERVED_LABELS.has(label)) return null;

  return label;
};

export const resolveTenant = async (req, res, next) => {
  let tenantId = defaultTenantId();

  const slug = _slugForHost(req.hostname, process.env.TENANT_HOST_SUFFIX);

  if (slug) {
    let tenant;
    try {
      tenant = await lookupBySlug(slug);
    } catch (error) {
      // Deliberately not falling back to the default operator. A lookup that
      // failed is not evidence the request belongs to the seeded tenant, and
      // guessing here would serve one operator's data under another's
      // hostname.
      logger.error('[tenant] resolution failed', {
        host: req.hostname,
        error: error.message,
      });
      return next(error);
    }

    // Same 404 for "no such operator" and "suspended", so the response does
    // not confirm which slugs exist. The distinction is in the log, where the
    // operator can see it and the internet cannot.
    if (!tenant || tenant.status !== 'active') {
      logger.warn('[tenant] unresolved host', {
        host: req.hostname,
        slug,
        reason: tenant ? `status=${tenant.status}` : 'no such tenant',
      });
      return res.status(404).json({ success: false, error: 'Unknown tenant' });
    }

    tenantId = tenant.id;
  }

  req.tenantId = tenantId;
  runWithTenant(tenantId, () => next());
};
