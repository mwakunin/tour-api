// src/services/supplierInvoice.service.js
//
// A supplier invoice is a document and a debt, and this keeps them in one
// transaction: the row that records what the lodge sent, and the payable that
// puts it in the books. Either both land or neither does — an invoice with no
// obligation is money owed that nothing reports, and an obligation with no
// invoice is a debt nobody can trace to a document.
//
// The money never lives here. Amount, currency, due date and status all belong
// to the obligation, and outstanding is derived from allocations rather than
// stored, so what this returns cannot disagree with the ledger.

import { and, eq, sql, desc, count } from 'drizzle-orm';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { supplierInvoices } from '#models/supplierInvoice.model.js';
import {
  counterparties,
  obligations,
  allocations,
} from '#models/money.model.js';
import * as money from '#services/money.service.js';
import { decimalToCents, centsToDecimal } from '#utils/money.js';
import logger from '#config/logger.js';

const SOURCE = 'supplier_invoice';

const NOT_FOUND = 'Supplier invoice not found';
const SUPPLIER_NOT_FOUND = 'Supplier not found';
const NOT_A_SUPPLIER = 'That counterparty is not a supplier';
const SUPPLIER_INACTIVE = 'That supplier is deactivated';
const DUPLICATE = 'That supplier has already sent an invoice with that number';

/** issued_on plus the supplier's net terms, in whole days. */
const addDays = (isoDate, days) => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const shape = (row) => ({
  id: row.id,
  counterparty_id: row.counterparty_id,
  supplier_name: row.supplier_name ?? null,
  invoice_number: row.invoice_number,
  issued_on: row.issued_on,
  notes: row.notes,
  created_at: row.created_at,
  updated_at: row.updated_at,

  // Everything below is the obligation's, read through rather than copied.
  obligation_id: row.obligation_id,
  amount: centsToDecimal(row.amount_cents),
  amount_cents: row.amount_cents,
  currency: row.currency,
  due_on: row.due_on,
  status: row.status,
  outstanding_cents: row.outstanding_cents,
  outstanding: centsToDecimal(row.outstanding_cents),
});

// One statement rather than a query per invoice: outstanding is
// amount_cents minus what has been allocated, and asking for it row by row is
// how a list endpoint becomes N+1 the moment somebody has more than a handful
// of invoices.
// Named once and reused by the projection, the HAVING clause and the count.
// Three copies of the same aggregate is how a filter and its total end up
// disagreeing about which rows exist.
const outstandingExpr = sql`${obligations.amount_cents} - coalesce(sum(${allocations.amount_cents}), 0)`;

const invoiceSelection = {
  id: supplierInvoices.id,
  counterparty_id: supplierInvoices.counterparty_id,
  invoice_number: supplierInvoices.invoice_number,
  issued_on: supplierInvoices.issued_on,
  notes: supplierInvoices.notes,
  created_at: supplierInvoices.created_at,
  updated_at: supplierInvoices.updated_at,
  supplier_name: counterparties.name,
  obligation_id: obligations.id,
  amount_cents: obligations.amount_cents,
  currency: obligations.currency,
  due_on: obligations.due_on,
  status: obligations.status,
  outstanding_cents: outstandingExpr.mapWith(Number),
};

const invoiceQuery = (tx) =>
  tx
    .select(invoiceSelection)
    .from(supplierInvoices)
    // Inner join: an invoice always has an obligation, because they are
    // written together. If one ever does not, it is a bug worth seeing as a
    // missing row rather than papering over with a left join and nulls.
    .innerJoin(
      obligations,
      and(
        eq(obligations.source_type, SOURCE),
        eq(obligations.source_id, supplierInvoices.id)
      )
    )
    .innerJoin(
      counterparties,
      eq(counterparties.id, supplierInvoices.counterparty_id)
    )
    .leftJoin(allocations, eq(allocations.obligation_id, obligations.id))
    .groupBy(supplierInvoices.id, obligations.id, counterparties.name);

/**
 * Records the document and raises the payable, together.
 *
 * Currency and due date fall back to the supplier's own configuration, which
 * is what storing default_currency and payment_terms_days on the counterparty
 * was for. Passing either overrides it for this invoice.
 */
export const createSupplierInvoice = async (validated) => {
  const {
    counterparty_id,
    invoice_number,
    issued_on,
    amount,
    currency,
    due_on,
    notes = null,
  } = validated;

  const amountCents = decimalToCents(amount);

  try {
    return await withTenantDb(async (tx) => {
      const [supplier] = await tx
        .select()
        .from(counterparties)
        .where(eq(counterparties.id, counterparty_id))
        .limit(1);

      // RLS makes another tenant's counterparty invisible rather than
      // forbidden, so absent and "belongs to somebody else" are one answer.
      if (!supplier) throw new Error(SUPPLIER_NOT_FOUND);
      if (supplier.type !== 'supplier') throw new Error(NOT_A_SUPPLIER);
      if (!supplier.is_active) throw new Error(SUPPLIER_INACTIVE);

      const [invoice] = await tx
        .insert(supplierInvoices)
        .values({
          counterparty_id,
          invoice_number,
          issued_on,
          notes,
          // After the spread-equivalent fields, so caller input cannot set it.
          tenant_id: currentTenantId(),
        })
        .returning();

      const dueOn =
        due_on ??
        (supplier.payment_terms_days === null
          ? issued_on
          : addDays(issued_on, supplier.payment_terms_days));

      // Nested withTenantDb reuses this transaction, so the obligation and its
      // accrual are written with the invoice or not at all.
      const obligation = await money.createObligation({
        direction: 'payable',
        kind: 'full',
        counterpartyId: counterparty_id,
        sourceType: SOURCE,
        sourceId: invoice.id,
        amountCents,
        currency: currency ?? supplier.default_currency,
        dueOn,
        description: `${supplier.name} ${invoice_number}`,
      });

      logger.info('[supplierInvoice] recorded', {
        invoiceId: invoice.id,
        obligationId: obligation.id,
        counterpartyId: counterparty_id,
      });

      return shape({
        ...invoice,
        supplier_name: supplier.name,
        obligation_id: obligation.id,
        amount_cents: obligation.amount_cents,
        currency: obligation.currency,
        due_on: obligation.due_on,
        status: obligation.status,
        outstanding_cents: obligation.amount_cents,
      });
    });
  } catch (error) {
    // 23505 on supplier_invoices_number_per_supplier: the same supplier has
    // already sent this number. Answered as a conflict, because entering an
    // invoice twice is an ordinary mistake and the caller needs to know it was
    // refused rather than silently merged.
    if (error.cause?.code === '23505') throw new Error(DUPLICATE);
    throw error;
  }
};

export const listSupplierInvoices = (filters = {}) => {
  const { page = 1, limit = 10, counterparty_id, status } = filters;
  const offset = (page - 1) * limit;

  const conditions = [];
  if (counterparty_id) {
    conditions.push(eq(supplierInvoices.counterparty_id, counterparty_id));
  }
  // void is a status on the obligation. open and settled are both status
  // 'open' and differ only by whether anything is left, which is an aggregate
  // and so belongs in HAVING rather than WHERE.
  if (status === 'void') conditions.push(eq(obligations.status, 'void'));
  if (status === 'open' || status === 'settled') {
    conditions.push(eq(obligations.status, 'open'));
  }

  let having;
  if (status === 'open') having = sql`${outstandingExpr} > 0`;
  if (status === 'settled') having = sql`${outstandingExpr} = 0`;

  return withTenantDb(async (tx) => {
    const filtered = () => {
      let q = invoiceQuery(tx);
      if (conditions.length) q = q.where(and(...conditions));
      if (having) q = q.having(having);
      return q;
    };

    const rows = await filtered()
      .orderBy(desc(supplierInvoices.issued_on))
      .limit(limit)
      .offset(offset);

    // Counted over the same filtered query, as a subquery. Filtering the page
    // in JavaScript after LIMIT would return fewer rows than asked for while
    // more existed, and a total that counted rows the filter had removed.
    const [totals] = await tx
      .select({ total: count() })
      .from(filtered().as('filtered_invoices'));

    return {
      data: rows.map(shape),
      total: Number(totals?.total ?? 0),
      page,
      limit,
    };
  });
};

export const getSupplierInvoiceById = async (id) => {
  const [row] = await withTenantDb((tx) =>
    invoiceQuery(tx).where(eq(supplierInvoices.id, id)).limit(1)
  );

  if (!row) throw new Error(NOT_FOUND);
  return shape(row);
};

/**
 * Voids the invoice's payable.
 *
 * The invoice row stays: the supplier did send it, and deleting the record of
 * a document because it turned out not to be owed loses the reason it was
 * cancelled. money.voidObligation reverses the unsettled part of the accrual,
 * leaving anything already paid alone — that is a refund question, not a
 * bookkeeping one.
 */
export const voidSupplierInvoice = async (id) => {
  const voided = await withTenantDb(async (tx) => {
    const [row] = await invoiceQuery(tx)
      .where(eq(supplierInvoices.id, id))
      .limit(1);

    if (!row) throw new Error(NOT_FOUND);

    await money.voidObligation(row.obligation_id);
    return row;
  });

  logger.info('[supplierInvoice] voided', {
    invoiceId: id,
    obligationId: voided.obligation_id,
  });

  return getSupplierInvoiceById(id);
};

export {
  NOT_FOUND as SUPPLIER_INVOICE_NOT_FOUND,
  SUPPLIER_NOT_FOUND,
  NOT_A_SUPPLIER,
  SUPPLIER_INACTIVE,
  DUPLICATE as SUPPLIER_INVOICE_DUPLICATE,
};
