// Migration 0007 defaulted every tenant-scoped tenant_id to the seed operator
// while the discriminator was being threaded through the handlers. That was a
// crutch with a known failure mode: an INSERT that forgot tenant_id did not
// fail — it silently filed the row under Footloose. Migration 0011 dropped
// the defaults once every insert site set the column explicitly. These tests
// pin both halves: the defaults stay gone from the schema, and an
// unattributed insert fails loudly instead of succeeding.
//
// Deliberately on the owner connection (db): the owner bypasses RLS, so this
// isolates the DEFAULT's behavior from the policies. With the default gone,
// the only thing that could fill the column is gone too — even a role that
// sees everything cannot insert without naming its tenant.
import { eq, sql } from 'drizzle-orm';
import { db, initDatabase } from '#config/database.js';
import { destinations } from '#models/destination.model.js';

// Every table 0007 defaulted. If a new tenant-scoped table is added, it must
// be created WITHOUT a default — add it to this list so the schema assertion
// keeps covering it.
const TABLES_WITH_DROPPED_DEFAULTS = [
  'blog_categories',
  'blog_posts',
  'bookings',
  'destinations',
  'files',
  'payments',
  'tour_destinations',
  'tours',
];

describe('tenant_id has no default to hide behind', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('dropped the seed-tenant default on every tenant-scoped table', async () => {
    const result = await db.execute(sql`
      SELECT table_name, column_default
      FROM information_schema.columns
      WHERE column_name = 'tenant_id' AND table_schema = 'public'
    `);
    const rows = Array.isArray(result) ? result : result.rows;

    // postgres-js returns information-schema columns lowercase. Map with
    // explicit keys rather than `??`: a legitimate NULL default is nullish,
    // so `r.column_default ?? r.COLUMN_DEFAULT` turns every NULL into
    // undefined and the assertion into a false positive.
    const defaultsByName = Object.fromEntries(
      rows.map((r) => [r.table_name, r.column_default])
    );

    for (const table of TABLES_WITH_DROPPED_DEFAULTS) {
      // undefined would mean the table itself vanished — fail with a
      // distinct message so a typo in the list is not misread as a default.
      expect(defaultsByName).toHaveProperty(table);
      expect(defaultsByName[table]).toBeNull();
    }
  });

  it('rejects an insert that does not name its tenant', async () => {
    let created = null;
    let insertError = null;
    try {
      [created] = await db
        .insert(destinations)
        .values({
          title: `No Tenant ${Date.now()}`,
          slug: `no-tenant-${Date.now()}`,
          description: 'Must fail: the row does not name its operator.',
          image: 'https://example.com/no-tenant.jpg',
          country: 'Kenya',
        })
        .returning();
    } catch (e) {
      insertError = e;
    }

    try {
      expect(insertError).not.toBeNull();
      // Drizzle wraps the driver error in DrizzleQueryError ("Failed query:
      // ..."); the Postgres error carrying the SQLSTATE is on .cause.
      const pgError = insertError.cause ?? insertError;
      expect(pgError).toMatchObject({ code: '23502' });
      expect(pgError.message).toContain('tenant_id');
    } finally {
      // Against pre-0011 state (revert-proofing, or if a default ever
      // returns) this insert SUCCEEDS and lands in the seed tenant's books.
      // Never leave that row behind.
      if (created) {
        await db.delete(destinations).where(eq(destinations.id, created.id));
      }
    }
  });
});
