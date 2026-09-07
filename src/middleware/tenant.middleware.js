// src/middleware/tenant.middleware.js
//
// Puts the current operator into AsyncLocalStorage for the life of the
// request, so every `withTenantDb` call underneath it scopes to that tenant.
//
// RESOLUTION IS DELIBERATELY TRIVIAL FOR NOW. There is one operator, seeded by
// migration 0007, and no subdomain routing, no custom domains and no tenant
// signup. Resolving from a header or a hostname before any of that exists
// would be inventing a contract with nothing on the other end of it. When
// operator #2 arrives this is the single place that changes: read the
// hostname, look the tenant up, 404 on an unknown one.
//
// It sets no database state on its own — the transaction and the
// `set_config` happen per operation in withTenantDb, because this app makes
// external HTTP calls mid-request and must not hold a connection across them.

import { runWithTenant } from '#config/tenantContext.js';

// Seeded by migration 0007. Also the value of the tenant_id DEFAULT, which is
// why the app behaves identically whether or not a handler has been migrated
// onto the tenant-scoped connection yet.
export const SEED_TENANT_ID = '00000000-0000-0000-0000-000000000001';

export const resolveTenant = (req, res, next) => {
  const tenantId = process.env.SEED_TENANT_ID || SEED_TENANT_ID;

  req.tenantId = tenantId;
  runWithTenant(tenantId, () => next());
};
