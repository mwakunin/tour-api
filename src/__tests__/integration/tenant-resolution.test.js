// src/__tests__/integration/tenant-resolution.test.js
//
// Resolution decides which operator a request belongs to, before any tenant is
// set and therefore before RLS can protect anything. Getting it wrong does not
// leak a row here and there — it hands one operator the whole of another's
// data, under a hostname that looks right. So these tests go through the HTTP
// surface with real Host headers rather than calling the middleware directly.

import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';

import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import { tenants } from '#models/schema.js';
import { memberships } from '#models/membership.model.js';
import { counterparties } from '#models/money.model.js';
import {
  createAuthenticatedAdminAgent,
  deleteTestUser,
  cleanupTestSession,
} from '../helpers/auth.helper.js';
import {
  _slugForHost,
  _clearTenantCache,
  _tenantCacheSize,
  _tenantCacheMax,
  _rememberTenant,
  UNRESOLVABLE,
} from '#middleware/tenant.middleware.js';

const SUFFIX = 'tourops.test';

const TENANT_ALPHA = '00000000-0000-0000-0000-0000000000c1';
const TENANT_SUSPENDED = '00000000-0000-0000-0000-0000000000c2';

describe('tenant resolution', () => {
  describe('_slugForHost', () => {
    // The suffix is what makes subdomain routing safe to switch on: without
    // it, the first label of api.footlooseadventures.com is a tenant slug.
    it('resolves nothing when no suffix is configured', () => {
      expect(_slugForHost('acme.tourops.test', undefined)).toBeNull();
      expect(_slugForHost('acme.tourops.test', '')).toBeNull();
    });

    it('reads the label under the suffix', () => {
      expect(_slugForHost('acme.tourops.test', SUFFIX)).toBe('acme');
      expect(_slugForHost('ACME.TourOps.Test', SUFFIX)).toBe('acme');
      // A fully-qualified name with the root dot still names the same host.
      expect(_slugForHost('acme.tourops.test.', SUFFIX)).toBe('acme');
      // A leading dot on the suffix is the same suffix.
      expect(_slugForHost('acme.tourops.test', `.${SUFFIX}`)).toBe('acme');
    });

    it('treats the apex and anything outside the suffix as the default', () => {
      expect(_slugForHost(SUFFIX, SUFFIX)).toBeNull();
      expect(_slugForHost('footlooseadventures.com', SUFFIX)).toBeNull();
      expect(_slugForHost('api.footlooseadventures.com', SUFFIX)).toBeNull();
      expect(_slugForHost('', SUFFIX)).toBeNull();
      expect(_slugForHost(undefined, SUFFIX)).toBeNull();
      // Not a subdomain of the suffix, however much it looks like one.
      expect(_slugForHost('eviltourops.test', SUFFIX)).toBeNull();
    });

    it('reserves the deployment-level hostnames', () => {
      for (const label of ['api', 'www', 'app', 'admin']) {
        expect(_slugForHost(`${label}.${SUFFIX}`, SUFFIX)).toBeNull();
      }
    });

    it('refuses a deeper host rather than defaulting it', () => {
      // Under our routing domain but naming no single operator. Returning null
      // would serve it the seeded tenant, which is the confusion the suffix
      // exists to prevent.
      //
      // UNRESOLVABLE rather than the string 'a.b': that used to be returned as
      // a slug on the reasoning that no row could match it, which was wrong.
      // tenants.slug is varchar(63) and, until the CHECK constraint below,
      // carried no format rule — a tenant registered as `a.b` would have been
      // found by a lookup and served under this host.
      expect(_slugForHost(`a.b.${SUFFIX}`, SUFFIX)).toBe(UNRESOLVABLE);
      expect(_slugForHost(`a.b.c.${SUFFIX}`, SUFFIX)).toBe(UNRESOLVABLE);
    });
  });

  describe('the hostname cache', () => {
    // With a suffix configured the cache key is chosen by the caller, so an
    // unbounded Map is a way to grow this process's memory from the outside.
    beforeEach(() => _clearTenantCache());
    afterAll(() => _clearTenantCache());

    it('stays bounded however many distinct hostnames arrive', () => {
      const max = _tenantCacheMax();
      for (let i = 0; i < max + 500; i += 1) {
        _rememberTenant(`scan-${i}`, null);
      }

      expect(_tenantCacheSize()).toBe(max);
    });

    it('evicts the oldest write, not the newest', () => {
      const max = _tenantCacheMax();
      _rememberTenant('first-in', { id: 'x', status: 'active' });
      for (let i = 0; i < max; i += 1) {
        _rememberTenant(`scan-${i}`, null);
      }

      // A scan does flush real operators out — that costs them one query to
      // re-read. The alternative to evicting something is evicting nothing.
      expect(_tenantCacheSize()).toBe(max);
      expect(_tenantCacheMax()).toBeGreaterThan(0);
    });
  });

  describe('over HTTP', () => {
    let adminAgent;
    let testAdmin;
    let adminSessionId;
    let originalSuffix;

    beforeAll(async () => {
      await initDatabase();

      // Owner-plane writes: creating operators is deliberately not something
      // the runtime role can do.
      await db
        .insert(tenants)
        .values([
          {
            id: TENANT_ALPHA,
            name: 'Alpha Safaris',
            slug: 'alpha-resolution',
            booking_ref_prefix: 'AL',
            status: 'active',
          },
          {
            id: TENANT_SUSPENDED,
            name: 'Lapsed Safaris',
            slug: 'lapsed-resolution',
            booking_ref_prefix: 'LP',
            status: 'suspended',
          },
        ])
        .onConflictDoNothing();

      await db
        .insert(counterparties)
        .values({
          tenant_id: TENANT_ALPHA,
          type: 'supplier',
          name: 'Alpha-only lodge',
          default_currency: 'USD',
        })
        .onConflictDoNothing();
    });

    beforeEach(async () => {
      originalSuffix = process.env.TENANT_HOST_SUFFIX;
      process.env.TENANT_HOST_SUFFIX = SUFFIX;
      // A minute of caching outlives a test that just changed a status.
      _clearTenantCache();

      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
      adminSessionId = adminAuth.sessionId;
    });

    afterEach(async () => {
      if (originalSuffix === undefined) {
        delete process.env.TENANT_HOST_SUFFIX;
      } else {
        process.env.TENANT_HOST_SUFFIX = originalSuffix;
      }
      _clearTenantCache();

      await deleteTestUser(testAdmin.id);
      await cleanupTestSession(redis, adminSessionId);
    });

    afterAll(async () => {
      await db
        .delete(counterparties)
        .where(eq(counterparties.tenant_id, TENANT_ALPHA));
      await db
        .delete(tenants)
        .where(inArray(tenants.id, [TENANT_ALPHA, TENANT_SUSPENDED]));
      await redis.quit();
    });

    it("refuses an operator's hostname to an admin who is not a member there", async () => {
      // This assertion used to be `.expect(200)`, and the test only checked
      // that the two hostnames returned DIFFERENT rows. That is the hole
      // written down as a passing test: a seeded-tenant admin reached Alpha's
      // hostname and was served Alpha's supplier list, because authority came
      // from the global user.role and resolution alone decided whose data to
      // read.
      //
      // Authentication is global — a person may work for two operators — so
      // resolution cannot be what separates them. Membership is.
      await adminAgent
        .get('/api/counterparties')
        .set('Host', `alpha-resolution.${SUFFIX}`)
        .expect(403);

      // Same session, same route, the hostname they DO hold a membership at.
      await adminAgent
        .get('/api/counterparties')
        .set('Host', `api.${SUFFIX}`)
        .expect(200);
    });

    it('serves the operator its hostname names, and only that operator', async () => {
      // The original intent of the test above, preserved: with a membership at
      // Alpha, the admin gets through, and what they get is Alpha's data and
      // not the seeded tenant's.
      await db
        .insert(memberships)
        .values({
          tenant_id: TENANT_ALPHA,
          user_id: testAdmin.id,
          role: 'admin',
        })
        .onConflictDoNothing();

      const alpha = await adminAgent
        .get('/api/counterparties')
        .set('Host', `alpha-resolution.${SUFFIX}`)
        .expect(200);

      expect(alpha.body.data).toHaveLength(1);
      expect(alpha.body.data[0].name).toBe('Alpha-only lodge');

      const seeded = await adminAgent
        .get('/api/counterparties')
        .set('Host', `api.${SUFFIX}`)
        .expect(200);

      expect(
        seeded.body.data.some((row) => row.name === 'Alpha-only lodge')
      ).toBe(false);
    });

    it('resolves the tenant for /api/auth, so sign-up knows who it is for', async () => {
      // The tenant a person registers WITH is knowable only from the request
      // that registers them, so /api/auth has to resolve before better-auth
      // handles it -- otherwise a sign-up hook has no tenant to attach a
      // membership to. This asserts the middleware is actually in front of it:
      // an unresolvable host is refused rather than quietly served by the
      // seeded operator.
      //
      // /api/auth used to sit ahead of tenant resolution entirely, so this
      // request would have reached better-auth and created an account.
      await request(app)
        .post('/api/auth/sign-up/email')
        .set('Host', `no-such-operator.${SUFFIX}`)
        .send({
          email: `orphan-${Date.now()}@example.com`,
          password: 'TestPassword123!',
          name: 'Orphan',
        })
        .expect(404);
    });

    it('404s an unknown operator instead of falling back to the seeded one', async () => {
      const response = await adminAgent
        .get('/api/counterparties')
        .set('Host', `no-such-operator.${SUFFIX}`)
        .expect(404);

      expect(response.body.error).toBe('Unknown tenant');
    });

    it('404s a multi-label host without looking it up', async () => {
      const response = await adminAgent
        .get('/api/counterparties')
        .set('Host', `a.b.${SUFFIX}`)
        .expect(404);

      expect(response.body.error).toBe('Unknown tenant');
      // Refused before the database is reached, so nothing was cached. That
      // is the point: the lookup is what a `foo.bar` slug would have matched.
      expect(_tenantCacheSize()).toBe(0);
    });

    it('refuses to store a slug that is not one DNS label', async () => {
      // The other door onto the same problem. The middleware never asks about
      // a dotted host now, and this makes sure a dotted slug cannot exist to
      // be asked about — the column exists for subdomain routing, so its
      // values have to be things a subdomain can be.
      const failure = await db
        .insert(tenants)
        .values({
          name: 'Dotted Operator',
          slug: 'foo.bar',
          booking_ref_prefix: 'DT',
        })
        .catch((error) => error);

      // 23514 is check_violation.
      expect(failure.cause?.code).toBe('23514');
    });

    it('404s a suspended operator without confirming it exists', async () => {
      const response = await adminAgent
        .get('/api/counterparties')
        .set('Host', `lapsed-resolution.${SUFFIX}`)
        .expect(404);

      // Byte-identical to the unknown-operator response: a different message
      // would let anyone enumerate which operators are real.
      expect(response.body.error).toBe('Unknown tenant');
    });

    it('resolves the seeded operator when no suffix is configured', async () => {
      delete process.env.TENANT_HOST_SUFFIX;

      // The hostname that would have named Alpha a moment ago. With routing
      // off it means nothing, which is what keeps every deployment today
      // behaving exactly as it did before resolution existed.
      const response = await adminAgent
        .get('/api/counterparties')
        .set('Host', `alpha-resolution.${SUFFIX}`)
        .expect(200);

      expect(
        response.body.data.some((row) => row.name === 'Alpha-only lodge')
      ).toBe(false);
    });
  });
});
