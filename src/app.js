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
import { corsOptions } from '#config/cors.config.js';
import usersRoutes from '#routes/users.routes.js';
import adminTestRoutes from '#routes/admin-test.routes.js';

const app = express();

// ✅ ADD THIS LINE - Trust Cloudflare proxy
app.set('trust proxy', 1);

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
app.use('/api/test', adminTestRoutes);
app.use('/api/destinations', destinationRoutes);
app.use('/api/tours', tourRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/payments', paymentRoutes);
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
