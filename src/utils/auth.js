import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '#config/database.js';
import logger from '#config/logger.js';
import * as schema from '#models/schema.js';
import { emailService } from '#services/email.service.js';

// `trustedOrigins` is a SET of origins better-auth accepts as a callbackURL or
// redirect target, so it is comma-separated — apex, www and a preview URL can be
// trusted at once, which makes a domain migration an overlap instead of a hard flip.
//
// It reads TRUSTED_ORIGINS and NOT FRONTEND_URL as a list, deliberately.
// FRONTEND_URL is a single base URL that gets string-concatenated into the Paystack
// callback (services/paystack.service.js), the Pesapal redirects
// (controllers/payment.controller.js) and the booking link in emails
// (services/email.service.js). A comma in it silently yields
// "https://a,https://b/payment/callback" and breaks all three with no startup error.
//
// Falling back to FRONTEND_URL keeps a deploy that has not set TRUSTED_ORIGINS yet
// behaving exactly as before — a single origin is a valid one-element list.
const trustedOrigins = (
  process.env.TRUSTED_ORIGINS ||
  process.env.FRONTEND_URL ||
  ''
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (trustedOrigins.length === 0) {
  // Not fatal, but every OAuth sign-in will fail with 403 INVALID_CALLBACK_URL,
  // and better-auth reports that per-request rather than at startup.
  logger.error(
    '[auth] trustedOrigins is empty — set TRUSTED_ORIGINS (or FRONTEND_URL). ' +
      'All OAuth callbacks will be rejected with INVALID_CALLBACK_URL.'
  );
} else {
  logger.info('[auth] trustedOrigins:', trustedOrigins);
}

if (!process.env.TRUSTED_ORIGINS && process.env.FRONTEND_URL?.includes(',')) {
  // The exact misconfiguration this split was introduced to prevent.
  logger.error(
    '[auth] FRONTEND_URL contains a comma. It is concatenated into payment ' +
      'callbacks and email links, so a list there produces malformed URLs. ' +
      'Put the list in TRUSTED_ORIGINS and keep FRONTEND_URL a single origin.'
  );
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema, // pass your full schema so Better Auth finds the tables
  }),
  emailAndPassword: {
    enabled: true,
    sendResetPassword: ({ user, url }) => {
      emailService.sendResetPasswordEmail(user, url).catch((error) => {
        logger.error('Failed to send reset password email:', error);
      });
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh if older than 1 day
  },
  user: {
    additionalFields: {
      role: {
        type: 'string',
        defaultValue: 'user',
      },
    },
  },
  advanced: {
    ipAddress: {
      // Resolves the client IP for rate limiting. Order matters — first header
      // that yields a valid IP wins (@better-auth/core utils/ip.mjs `getIp`).
      //
      // Why not the default `x-forwarded-for` alone: behind the Vercel proxy it
      // arrives as "<real-client>,<vercel-egress>" — two entries. better-auth
      // trusts a forwarded header only when it has exactly ONE entry unless
      // `trustedProxies` is set, so it resolved to null and every caller shared a
      // single bucket at 3 sign-ins per 10s site-wide. Observed in production:
      //   x-forwarded-for: "197.232.165.20,16.28.29.31"
      //
      // Why not `trustedProxies`: that would need Vercel's egress ranges, which
      // are not static or published outside Enterprise, so it would silently
      // break whenever an edge rotated.
      //
      // `x-vercel-forwarded-for` carries the real client as a single value, and
      // falling through to `x-forwarded-for` keeps direct-to-Cloud-Run requests
      // (which arrive with one entry) resolving correctly too.
      ipAddressHeaders: ['x-vercel-forwarded-for', 'x-forwarded-for'],
    },
  },
  trustedOrigins,
});
