// config/cors.js
import logger from './logger.js';

const allowedOrigins = {
  development: ['http://localhost:3000', 'http://localhost:3001'],
  production: [
    'https://footlooseadventures.co.ke',
    'https://www.footlooseadventures.co.ke',
    'https://app.footlooseadventures.co.ke',
  ],
};

// ✅ Always return specific origins (never null)
function getAllowedOrigins() {
  if (process.env.ALLOWED_ORIGINS) {
    const origins = process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
    logger.info('[CORS] Using origins from ALLOWED_ORIGINS env var:', origins);
    return origins;
  }

  const origins =
    allowedOrigins[process.env.NODE_ENV] || allowedOrigins.development;
  logger.info(`[CORS] Using origins for ${process.env.NODE_ENV}:`, origins);
  return origins;
}

export const corsOptions = {
  origin: (origin, callback) => {
    const origins = getAllowedOrigins();

    // Always allow requests with no origin (Postman, curl, mobile apps)
    if (!origin) {
      logger.debug('[CORS] Request with no origin allowed');
      return callback(null, true);
    }

    // Check if origin is in allowed list
    if (origins.includes(origin)) {
      logger.debug(`[CORS] Origin allowed: ${origin}`);
      return callback(null, true);
    } else {
      logger.warn(`[CORS] Origin blocked: ${origin}`);
      callback(new Error(`CORS: Origin ${origin} not allowed`));
    }
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
