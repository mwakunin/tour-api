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

// Add BEFORE all other routes, right after cors/helmet
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

// Every API route runs inside a tenant context. Mounted after health and auth
// so an unauthenticated probe does not need a tenant, and before the routes so
// that any withTenantDb call beneath them resolves.
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
