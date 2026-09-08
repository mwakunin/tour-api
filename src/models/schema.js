// Gather all table/enums/relations in one place

// Better Auth tables (user, session, account, verification)
export * from './user.model.js';

// Import & re-export destination models
export * from './destination.model.js';
export * from './payment.model.js';

// Import & re-export tour models
export * from './tour.model.js';

// Import & re-export booking models
export * from './booking.model.js';

// Import & re-export enums
export * from './enums.model.js';

// Import & re-export file models
export * from './file.model.js';

// Tenancy primitive
export * from './tenant.model.js';

// The portable money layer: counterparties, obligations, settlements,
// allocations, fx rates, ledger. See money.model.js for why it uses
// domain-neutral names.
export * from './money.model.js';

// Supplier invoices: the document a payable is raised from. Product-side
// rather than part of the money layer, which stays domain-neutral — see the
// source_type note in money.model.js.
export * from './supplierInvoice.model.js';
export * from './ledgerOutbox.model.js';

// 👉 Add more exports here if you create more tables later (reviews, payments, etc.)
