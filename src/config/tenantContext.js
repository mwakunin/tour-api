// src/config/tenantContext.js
//
// Carries the current tenant through a request and scopes database work to it.
//
// WHY THE TRANSACTION IS PER-OPERATION, NOT PER-REQUEST
//
// school-saas opens one transaction for the whole request and hands handlers a
// scoped client. That does not port here. This app calls Safaricom, Pesapal
// and Paystack from inside request handlers, interleaved with queries — see
// mpesa.service.js, which reads the database and then posts to Daraja in the
// same path. A transaction spanning the request would hold one of only 15
// production connections (3 in dev) open across a multi-second call to
// Safaricom; a handful of concurrent checkouts would exhaust the pool and the
// API would deadlock waiting on itself.
//
// So the tenant id lives in AsyncLocalStorage for the whole request, but the
// transaction is opened per operation and closed immediately. The isolation
// guarantee is identical: `set_config(..., true)` is transaction-scoped, so it
// cannot outlive the statement group or leak onto the next borrower of a
// pooled connection. Only the holding time differs — milliseconds instead of
// seconds. External calls belong between operations, never inside one.

import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { appDb } from '#config/appDatabase.js';

const storage = new AsyncLocalStorage();

/**
 * Runs `fn` with `tenantId` as the ambient tenant. Sets no database state on
 * its own — `withTenantDb` is what reaches Postgres.
 */
export const runWithTenant = (tenantId, fn) =>
  storage.run({ tenantId, tx: null }, fn);

/** The ambient tenant id, or null outside a tenant context. */
export const currentTenantId = () => storage.getStore()?.tenantId ?? null;

/**
 * Runs `fn(tx)` inside a short transaction with `app.tenant_id` set, so the
 * RLS policies from migration 0008 apply.
 *
 * Nested calls reuse the ambient transaction rather than opening a second one,
 * so a service calling another service does not deadlock against itself or
 * split one logical write across two transactions.
 */
// Not `async`: the body has nothing of its own to await, and marking it async
// only to satisfy the shape would trip require-await, while `return await`
// trips no-return-await. Returning promises directly keeps both happy and the
// guard still rejects rather than throwing synchronously.
export const withTenantDb = (fn) => {
  const store = storage.getStore();

  if (!store?.tenantId) {
    // Failing loudly beats querying with no tenant set. That would return zero
    // rows rather than leak, but a silent empty result is a worse bug to chase
    // than an exception naming the cause.
    return Promise.reject(
      new Error(
        '[tenantContext] withTenantDb called outside a tenant context. ' +
          'Wrap the call in runWithTenant(tenantId, ...).'
      )
    );
  }

  if (store.tx) return Promise.resolve(fn(store.tx));

  return appDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${store.tenantId}, true)`
    );
    return storage.run({ ...store, tx }, () => fn(tx));
  });
};
