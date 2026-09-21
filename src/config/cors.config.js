// config/cors.js
import logger from './logger.js';

// Development only. The production list used to sit here too, hardcoded to one
// operator's domains -- which is a bug in a product meant to serve many, and
// would have silently allowed the wrong origins on every other deployment.
// Production has no built-in list: it comes from the environment, and an empty
// one is an error rather than a default.
const allowedOrigins = {
  development: ['http://localhost:3000', 'http://localhost:3001'],
};

/**
 * The registrable domain whose subdomains may call this API.
 *
 * Once each operator has a hostname, the set of legal origins is unbounded --
 * one per tenant, created whenever somebody signs up -- so it cannot be an
 * enumerated list without an env var edit and a redeploy per customer.
 *
 * Set it to the bare domain: ALLOWED_ORIGIN_DOMAIN=tourops.com
 */
const originDomain = process.env.ALLOWED_ORIGIN_DOMAIN?.trim().toLowerCase();

/**
 * Whether `origin` is the configured domain or a subdomain of it.
 *
 * Compares the parsed hostname rather than the raw string, because a string
 * suffix test is the classic way to get this wrong: `endsWith('tourops.com')`
 * accepts `eviltourops.com` and, worse, anything at all before a path --
 * `https://attacker.net/?x=tourops.com`. URL parsing makes the host the host.
 *
 * The leading dot on the suffix is what separates `acme.tourops.com` from
 * `nottourops.com`, and the equality check is what still admits the apex.
 */
const matchesOriginDomain = (origin) => {
  if (!originDomain) return false;

  let host;
  let protocol;
  try {
    ({ hostname: host, protocol } = new URL(origin));
  } catch {
    return false;
  }

  // https only, except on loopback, where a dev server has no certificate.
  // An http origin under the real domain means somebody is being stripped.
  const isLoopback = host === 'localhost' || host === '127.0.0.1';
  if (protocol !== 'https:' && !isLoopback) return false;

  host = host.toLowerCase();
  return host === originDomain || host.endsWith(`.${originDomain}`);
};

// The exact-match list. Still the whole story for a single-operator
// deployment; alongside ALLOWED_ORIGIN_DOMAIN for a multi-tenant one.
function getAllowedOrigins() {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  if (process.env.NODE_ENV === 'production') return [];

  return allowedOrigins.development;
}

// Logged once at import rather than per request. The old code called
// getAllowedOrigins() inside the origin callback and logged there, so a busy
// API wrote this line for every preflight.
const configuredOrigins = getAllowedOrigins();

if (configuredOrigins.length === 0 && !originDomain) {
  const message =
    '[CORS] No origins configured. Set ALLOWED_ORIGINS, or ' +
    'ALLOWED_ORIGIN_DOMAIN for per-operator hostnames. Every ' +
    'browser request will be blocked.';

  // An error rather than a throw: the API still serves server-to-server
  // callers -- M-Pesa and Pesapal post here with no Origin at all -- so
  // refusing to boot would take payment callbacks down to fix a browser
  // problem.
  if (process.env.NODE_ENV === 'production') logger.error(message);
  else logger.warn(message);
} else {
  logger.info('[CORS] origins:', {
    exact: configuredOrigins,
    domain: originDomain ?? '(none)',
  });
}

export const corsOptions = {
  origin: (origin, callback) => {
    // Always allow requests with no origin (Postman, curl, mobile apps, and
    // the payment providers' server-to-server callbacks).
    if (!origin) return callback(null, true);

    if (configuredOrigins.includes(origin) || matchesOriginDomain(origin)) {
      return callback(null, true);
    }

    logger.warn(`[CORS] Origin blocked: ${origin}`);
    callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Cookie',
    'Accept',
  ],
  exposedHeaders: ['Set-Cookie'],
  optionsSuccessStatus: 200,
  maxAge: 86400,
};
