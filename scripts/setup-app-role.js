// Grants the runtime role its password and LOGIN.
//
// Kept out of the migration on purpose: a password does not belong in a file
// that gets committed. Migration 0008 creates `tourops_app` NOLOGIN with its
// grants and policies; this turns it into something that can connect.
//
//   APP_DB_PASSWORD=... pnpm run db:app-role
//
// Connects as the owner (DATABASE_URL) because only a superuser or a role
// with CREATEROLE may alter another role.

import '../src/config/loadEnv.js';
import postgres from 'postgres';

const ROLE = 'tourops_app';
const password = process.env.APP_DB_PASSWORD;

if (!password) {
  console.error(
    '[app-role] APP_DB_PASSWORD is not set.\n' +
      '           Set it in .env (and .env.test), then re-run.'
  );
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  // ALTER ROLE will not accept a bind parameter for the password, so it is
  // interpolated — quoted through postgres.js's literal escaping rather than
  // by hand.
  await sql.unsafe(
    `ALTER ROLE ${ROLE} WITH LOGIN PASSWORD ${escapeLiteral(password)}`
  );
  console.log(`[app-role] ${ROLE} can now log in.`);
} finally {
  await sql.end();
}

function escapeLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
