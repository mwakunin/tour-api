import winston from 'winston';

// Build transports array based on environment
const transports = [
  // Console transport - always available
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }),
];

// Only add file transports in non-production environments
if (process.env.NODE_ENV !== 'production') {
  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
    })
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  // Log label for the deployment. Not customer-facing, but it is still an
  // operator name baked into config -- env-configurable per CLAUDE.md's
  // branding rule, defaulting to the seed operator.
  defaultMeta: {
    service: process.env.LOG_SERVICE_NAME || 'footlooseadventures-api',
  },
  transports,
});

export default logger;
