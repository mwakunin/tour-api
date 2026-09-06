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

// 👉 Add more exports here if you create more tables later (reviews, payments, etc.)
