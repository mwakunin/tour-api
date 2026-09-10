import express from 'express';
import logger from '#config/logger.js';
import helmet from 'helmet';
import morgan from 'morgan';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import cookieParser from 'cookie-parser';
import * as Sentry from '@sentry/node';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';
import { errorHandler } from './middleware/error.middleware.js';
import { resolveTenant } from '#middleware/tenant.middleware.js';
import { auth } from '#utils/auth.js';
import authRoutes from '#routes/auth.routes.js';
import destinationRoutes from '#routes/destination.routes.js';
import tourRoutes from '#routes/tour.routes.js';
import uploadRoutes from '#routes/upload.routes.js';
import bookingRoutes from '#routes/booking.routes.js';
import paymentRoutes from '#routes/payment.routes.js';
import contactRoutes from '#routes/contact.routes.js';
import inquiryRoutes from '#routes/inquiry.routes.js';
import healthRoutes from '#routes/health.routes.js';
import blogRoutes from '#routes/blog.routes.js';
import chatRoutes from '#routes/chat.routes.js';
import counterpartyRoutes from '#routes/counterparty.routes.js';
import fxRateRoutes from '#routes/fxRate.routes.js';
import supplierInvoiceRoutes from '#routes/supplierInvoice.routes.js';
import settlementRoutes from '#routes/settlement.routes.js';
import obligationRoutes from '#routes/obligation.routes.js';
import ledgerOutboxRoutes from '#routes/ledgerOutbox.routes.js';
import { corsOptions } from '#config/cors.config.js';
import usersRoutes from '#routes/users.routes.js';
import adminTestRoutes from '#routes/admin-test.routes.js';

const app = express();

// How many proxies sit in front of this process and rewrite x-forwarded-for.
//
// Zero by default, because the API is published directly — docker-compose.prod
// maps 3000:3000 — so nothing upstream touches that header and whatever a
// caller sends arrives intact. That is not cosmetic: `trust proxy` is what
// makes req.ip read from the header, and req.ip keys Arcjet's rate limiting.
// better-auth is worse off still, resolving its rate-limit bucket from the
// header alone with no socket fallback, and trusting any value that carries a
// single entry. Between them, `x-forwarded-for: <anything>` picks your own
// throttle bucket and a fresh value per request removes the throttle.
//
// Set TRUSTED_PROXY_HOPS to the number of hops when an ingress that overwrites
// the header is actually in front (Cloudflare, nginx, Vercel: normally 1).
// Anything that is not a non-negative whole number means 0. Number.parseInt
// alone was not enough: it reads '-1' as -1, which is truthy, so the
// sanitisation below was skipped and the caller got their forwarded header
// back -- the exact bypass this block exists to close. It also reads '2abc'
// as 2, quietly trusting a hop the operator never configured.
const parseTrustedHops = (raw) => {
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) return 0;
  const hops = Number(value);
  return Number.isSafeInteger(hops) ? hops : 0;
};

const trustedHops = parseTrustedHops(process.env.TRUSTED_PROXY_HOPS);

app.set('trust proxy', trustedHops);

if (!trustedHops) {
  if (process.env.NODE_ENV === 'production') {
    // docker-compose.prod.yml puts Caddy in front and sets this to 1. Reaching
    // here in production means the API is being served directly, so every
    // session token, password and payment callback crosses the network in
    // cleartext — and better-auth reads the request protocol to decide whether
    // to mark its session cookie Secure, so it will correctly decide not to.
    logger.warn(
      '[App] TRUSTED_PROXY_HOPS=0 in production: nothing is terminating TLS ' +
        'in front of this process. Traffic is unencrypted. See ' +
        'docker-compose.prod.yml and deploy/Caddyfile.'
    );
  }

  // With no proxy to trust, this process becomes the trust boundary: the
  // forwarded headers are replaced with the address the connection actually
  // came from. `trust proxy` is 0 above, so req.ip is that socket address and
  // cannot be fed by the caller.
  //
  // Overwritten rather than deleted, because better-auth falls back to a
  // single shared bucket for every caller when it cannot resolve an address —
  // which would turn a rate-limit bypass into a rate-limit outage.
  app.use((req, _res, next) => {
    req.headers['x-forwarded-for'] = req.ip;
    delete req.headers['x-vercel-forwarded-for'];
    next();
  });
}

// ✅ IMPORTANT: Order matters for sessions!
app.use(cookieParser());

// CORS - make sure credentials are enabled
app.use(cors(corsOptions));

app.use(helmet());

// Add BEFORE all other routes, right after cors/helmet.
//
// resolveTenant now runs FIRST, so sign-up and sign-in happen inside a tenant
// context. That is what lets a registration create a membership: the tenant a
// person is registering WITH is knowable only from the request that registers
// them, and by the time any later middleware runs the sign-up has already
// committed.
//
// This was previously mounted after these routes, on the reasoning that an
// unauthenticated probe should not need a tenant. That reasoning does not
// survive multi-tenancy -- signing in at a hostname that names no operator is
// not a request anyone can answer, and answering it against the seeded tenant
// would attach the wrong operator to the session. With TENANT_HOST_SUFFIX
// unset, which is every deployment today, every host still resolves to the
// seeded tenant and nothing changes.
//
// Health checks stay outside it: they are mounted on '/' further down and are
// deliberately answerable without a tenant.
app.use('/api/auth', resolveTenant);
app.use('/api/auth', authRoutes);
app.all('/api/auth/*path', toNodeHandler(auth));

//app.use(express.json({ limit: '10mb' }));
app.use(
  express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(
  morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

// API Documentation (Swagger)
app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Footloose Adventures API Documentation',
  })
);

// Swagger JSON endpoint
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

app.get('/api', (req, res) => {
  res.status(200).json({
    message: 'API is running!',
    documentation: '/api-docs',
    version: '1.0.0',
  });
});

app.use('/', healthRoutes); // Registers /health and /api/health

// All other routes handle security individually

// Every API route runs inside a tenant context. Mounted after health so an
// unauthenticated probe does not need a tenant, and before the routes so that
// any withTenantDb call beneath them resolves.
//
// /api/auth resolves separately above, because it is mounted earlier.
app.use('/api', resolveTenant);

app.use('/api/users', usersRoutes);
// Development only. These routes echo req.user.email and the caller's
// permission set back to any authenticated user, and /moderator advertises a
// role check it does not perform. They are scaffolding, not product.
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/test', adminTestRoutes);
}
app.use('/api/destinations', destinationRoutes);
app.use('/api/tours', tourRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/payments', paymentRoutes);
// The cost side: suppliers, agents and the rest of the money layer's
// counterparties. Mounted after resolveTenant like every other /api route.
app.use('/api/counterparties', counterpartyRoutes);
app.use('/api/fx-rates', fxRateRoutes);
app.use('/api/supplier-invoices', supplierInvoiceRoutes);
app.use('/api/settlements', settlementRoutes);
// Read-only. What the unmatched worklist offers as candidates to match against.
app.use('/api/obligations', obligationRoutes);
// Accruals that failed to reach the books, and the retry for them.
app.use('/api/ledger-outbox', ledgerOutboxRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/inquiries', inquiryRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/chat', chatRoutes);

{
  /*
// ✅ Clear specific tour cache
app.get('/api/admin/clear-cache/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    await cache.del(`tour:slug:${slug}`);
    res.json({ 
      success: true, 
      message: `Cache cleared for ${slug}` 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Clear all tour caches
app.get('/api/admin/clear-cache', async (req, res) => {
  try {
    await cache.delPattern('tour:*');
    await cache.delPattern('tours:*');
    res.json({ 
      success: true, 
      message: 'All tour caches cleared' 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
*/
}

// 404 handler
app.use((req, res) => {
  logger.warn(`404 - Route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Route not found' });
});

// ✅ CRITICAL for Sentry v8+: This MUST be AFTER all routes but BEFORE custom error handler
Sentry.setupExpressErrorHandler(app);
// 4. Your custom error handler
app.use(errorHandler);

export default app;
