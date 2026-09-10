import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '#config/database.js';
import logger from '#config/logger.js';
import * as schema from '#models/schema.js';
import { emailService } from '#services/email.service.js';
import { memberships } from '#models/membership.model.js';
import { currentTenantId } from '#config/tenantContext.js';

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
// WILDCARDS ARE SUPPORTED, AND NEEDED ONCE OPERATORS HAVE HOSTNAMES.
//
// better-auth matches a pattern containing `*` with wildcardMatch rather than
// string equality, so an unbounded set of tenant origins can be expressed
// without an env edit per customer:
//
//   TRUSTED_ORIGINS=https://*.tourops.com
//
// Verified against 1.6.23's matcher rather than assumed. Two things it does
// that are worth knowing:
//
//   * the protocol is part of the match, so `http://acme.tourops.com` is
//     rejected by that pattern
//   * `*` spans dots, so it also matches `evil.acme.tourops.com` -- a nested
//     subdomain. _slugForHost returns UNRESOLVABLE for a label containing a
//     dot and the request 404s before anything reads the session, so the two
//     layers cover each other. Do not rely on this one alone.
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

// The registrable domain the session cookie is scoped to, e.g. ".tourops.app".
//
// Set it when the frontend and this API are separate hosts under one domain —
// app.tourops.app calling api.tourops.app. Without it better-auth sets a
// host-only cookie, which the browser sends only back to the API host, so the
// frontend's own middleware cannot read it and every protected route looks
// signed out to the server rendering it.
//
// UNSET IS THE DEFAULT AND CHANGES NOTHING. Same-origin deployments — anything
// proxying /api through the frontend — want a host-only cookie and should
// leave this alone.
//
// Only for subdomains of ONE registrable domain. Genuinely different domains
// are cross-site, which needs SameSite=None and a third-party cookie that
// Safari already blocks; a Domain attribute cannot span them.
const cookieDomain = process.env.COOKIE_DOMAIN?.trim() || null;

// REFUSED, NOT WARNED ABOUT.
//
// A Domain cookie attribute is a bare domain -- ".example.com". Give
// better-auth anything else and it sets a cookie the browser silently
// discards, so every sign-in appears to work and no session ever comes back.
// The first version of this only warned, and a COOKIE_DOMAIN of
// "http://localhost:3001" -- a URL, which is what somebody reading "the
// frontend's origin" would reasonably put -- broke every authenticated
// request in the whole suite while printing one line nobody was reading.
//
// Locking every user out is not a thing to be tentative about, so a
// malformed value stops the process here instead.
if (cookieDomain) {
  const looksLikeDomain =
    /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

  if (!looksLikeDomain.test(cookieDomain)) {
    throw new Error(
      `[auth] COOKIE_DOMAIN must be a bare domain such as ".example.com". ` +
        `Got "${cookieDomain}". No scheme, no port, no path — it is a cookie ` +
        `Domain attribute, not a URL, and an invalid one makes the browser ` +
        `discard every session cookie.`
    );
  }

  // A single label is never a domain somebody owns. "com" and "net" are
  // public suffixes: browsers refuse a Domain attribute set to one, discard
  // the cookie, and produce the same silent auth outage as the URL above.
  // localhost is the exception, and a real one — it is what a local
  // deployment sets.
  const labels = cookieDomain.replace(/^\./, '').split('.');
  if (labels.length < 2 && cookieDomain.replace(/^\./, '') !== 'localhost') {
    throw new Error(
      `[auth] COOKIE_DOMAIN "${cookieDomain}" is a single label. A cookie ` +
        'Domain must be a domain you control, such as ".example.com" — a ' +
        'public suffix like "com" is refused by every browser and the ' +
        'session cookie is silently discarded.'
    );
  }

  // WHAT THIS STILL DOES NOT CATCH, and deliberately. A multi-label public
  // suffix — "co.uk", "github.io" — is equally invalid as a cookie Domain and
  // passes here, because telling them apart from a real domain needs the
  // Public Suffix List: a dependency carrying thousands of entries that goes
  // stale between releases, to check one value an operator sets once at
  // deploy. The single-label case is worth catching because it is a plausible
  // slip; ".co.uk" would mean the operator owns no domain at all.
  if (!cookieDomain.startsWith('.')) {
    logger.warn(
      `[auth] COOKIE_DOMAIN is "${cookieDomain}"; a leading dot ` +
        `(".${cookieDomain}") is what scopes the cookie to every subdomain ` +
        'rather than one host.'
    );
  }
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
        // Better Auth accepts additionalFields as sign-up input unless this is
        // set. Without it a registrant could POST role:'admin' and receive
        // admin on every requireAdmin route. Role changes belong to the
        // admin-facing update path only.
        input: false,
      },
    },
  },
  advanced: {
    // Shares the session cookie across subdomains of one registrable domain,
    // so app.tourops.app and api.tourops.app both see it. Off unless
    // COOKIE_DOMAIN is set, which keeps every existing deployment on the
    // host-only cookie it has now.
    //
    // This also covers the OAuth state cookie, which is the half that
    // actually bites: a state written on one host and read on another is the
    // state_mismatch that made the frontend proxy auth through itself in the
    // first place.
    ...(cookieDomain
      ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }
      : {}),

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
      // Only headers the ingress is known to overwrite. Any header listed
      // here that the platform does not strip is caller-controlled, and this
      // value keys rate limiting — so trusting a Vercel header on a
      // non-Vercel deployment lets a caller pick their own rate-limit bucket
      // and defeat it. Opt in explicitly where the ingress guarantees it.
      //
      // x-forwarded-for is safe to read here in either deployment: with an
      // ingress in front the platform overwrites it, and without one app.js
      // replaces it with the socket address before this ever runs. See the
      // TRUSTED_PROXY_HOPS note there — that guarantee is what this relies on,
      // so do not weaken it without revisiting this list.
      ipAddressHeaders:
        process.env.TRUST_VERCEL_FORWARDED_FOR === 'true'
          ? ['x-vercel-forwarded-for', 'x-forwarded-for']
          : ['x-forwarded-for'],
    },
  },
  trustedOrigins,

  databaseHooks: {
    user: {
      create: {
        /**
         * Attaches every new account to the operator it registered with.
         *
         * Without this a sign-up produced a user belonging to nobody. The
         * 0029 backfill covered everyone who existed when memberships landed,
         * and then every registration after it created another orphan --
         * invisible while authorization only asked about admins, and a
         * lockout the moment anything asks "which operator is this person's".
         *
         * The tenant comes from AsyncLocalStorage, which is why app.js had to
         * move resolveTenant in front of /api/auth: by the time any later
         * middleware runs, this hook has already fired.
         */
        after: async (created) => {
          const tenantId = currentTenantId();

          if (!tenantId) {
            // Not fatal, and deliberately not. The account exists -- better-
            // auth has already committed it -- so throwing here would leave a
            // user who cannot sign up again (the email is taken) and cannot be
            // helped by trying. Loud, and recoverable by granting the
            // membership by hand.
            logger.error(
              '[auth] user created with no tenant context, so no membership ' +
                'was granted. They will be treated as belonging to no ' +
                'operator until one is added.',
              { userId: created.id }
            );
            return;
          }

          try {
            // Owner connection: `db` is what better-auth is configured with,
            // and this runs inside better-auth's own transaction rather than
            // under withTenantDb. The tenant_id written is the resolved one,
            // so the row lands where the RLS policy would have put it anyway.
            //
            // `customer` because this is the public registration path. Staff
            // are promoted afterwards; there is no self-service route to
            // authority, which is the point.
            await db.insert(memberships).values({
              tenant_id: tenantId,
              user_id: created.id,
              role: 'customer',
            });
          } catch (error) {
            // Same reasoning as above: the user row is already committed.
            logger.error('[auth] failed to grant membership on sign-up', {
              userId: created.id,
              tenantId,
              error: error.message,
            });
          }
        },
      },
    },
  },
});
