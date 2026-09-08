// src/services/bookingPnl.service.js
//
// What a booking actually made.
//
// Read from ledger_entries rather than from obligations, for two reasons.
// Ledger entries are already in the tenant's base currency, so a trip sold in
// USD with a lodge invoiced in KES adds up without converting anything here.
// And a voided obligation writes a reversing group rather than disappearing,
// so summing the ledger nets cancellations out on its own — asking obligations
// instead would mean remembering to exclude voided ones, and that is a filter
// somebody eventually forgets.
//
// Only accrual groups are counted: source_type 'obligation' and its reversal
// 'obligation_void'. Allocations move cash between accounts and change what is
// outstanding, not what was earned or spent, so including them would count the
// same revenue twice the moment a customer paid.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { bookings } from '#models/booking.model.js';
import { obligations, ledger_entries } from '#models/money.model.js';
import { supplierInvoices } from '#models/supplierInvoice.model.js';
import { tenants } from '#models/tenant.model.js';
import { centsToDecimal } from '#utils/money.js';

const NOT_FOUND = 'Booking not found';

// Debits are positive and credits negative, so revenue arrives as a negative
// number and costs as positive ones. Flipping revenue's sign here keeps the
// response in the shape a person expects — revenue 4200, cost 2900, margin
// 1300 — rather than making every caller remember the convention.
const ACCRUAL_SOURCES = ['obligation', 'obligation_void'];

export const bookingPnl = (bookingId) =>
  withTenantDb(async (tx) => {
    const [booking] = await tx
      .select({
        id: bookings.id,
        reference: bookings.booking_reference,
        currency: bookings.currency,
        status: bookings.status,
      })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .limit(1);

    // RLS makes another tenant's booking invisible rather than forbidden, so
    // absent and "belongs to somebody else" are the same answer.
    if (!booking) throw new Error(NOT_FOUND);

    const [tenant] = await tx
      .select({ base_currency: tenants.base_currency })
      .from(tenants)
      .where(eq(tenants.id, currentTenantId()))
      .limit(1);

    // Two ways money attaches to a booking. The receivable and the agent's
    // commission name it directly. A supplier's cost names the invoice, and
    // the invoice names the booking — so a lodge bill only counts against a
    // trip when somebody attributed it to one.
    const direct = await tx
      .select({ id: obligations.id })
      .from(obligations)
      .where(
        and(
          eq(obligations.source_type, 'booking'),
          eq(obligations.source_id, bookingId)
        )
      );

    const viaInvoices = await tx
      .select({ id: obligations.id })
      .from(obligations)
      .innerJoin(
        supplierInvoices,
        and(
          eq(obligations.source_type, 'supplier_invoice'),
          eq(obligations.source_id, supplierInvoices.id)
        )
      )
      .where(eq(supplierInvoices.booking_id, bookingId));

    const obligationIds = [...direct, ...viaInvoices].map((row) => row.id);

    const totals = { revenue: 0, cost_of_sales: 0, commission_expense: 0 };

    if (obligationIds.length) {
      const rows = await tx
        .select({
          account: ledger_entries.account,
          total: sql`sum(${ledger_entries.base_amount_cents})`.mapWith(Number),
        })
        .from(ledger_entries)
        .where(
          and(
            inArray(ledger_entries.source_type, ACCRUAL_SOURCES),
            inArray(ledger_entries.source_id, obligationIds)
          )
        )
        .groupBy(ledger_entries.account);

      for (const row of rows) {
        if (row.account in totals) totals[row.account] = row.total;
      }
    }

    // Revenue is credited, so it sums negative; costs are debited and sum
    // positive.
    const revenueCents = -totals.revenue;
    const costOfSalesCents = totals.cost_of_sales;
    const commissionCents = totals.commission_expense;
    const marginCents = revenueCents - costOfSalesCents - commissionCents;

    return {
      booking_id: booking.id,
      booking_reference: booking.reference,
      booking_status: booking.status,
      booking_currency: booking.currency,

      // Everything below is in the operator's own currency, whatever the trip
      // was sold in or the lodge invoiced in.
      base_currency: tenant?.base_currency ?? null,

      revenue: centsToDecimal(revenueCents),
      cost_of_sales: centsToDecimal(costOfSalesCents),
      commission: centsToDecimal(commissionCents),
      margin: centsToDecimal(marginCents),

      revenue_cents: revenueCents,
      cost_of_sales_cents: costOfSalesCents,
      commission_cents: commissionCents,
      margin_cents: marginCents,

      // Guarded, because a cancelled booking nets revenue to zero and this is
      // the one number people put on a dashboard without checking.
      margin_pct:
        revenueCents === 0
          ? null
          : Math.round((marginCents / revenueCents) * 1000) / 10,
    };
  });

export { NOT_FOUND as BOOKING_NOT_FOUND };
