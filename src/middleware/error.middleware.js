// middleware/error.middleware.js
import logger from '#config/logger.js';
import {
  MAX_FILES,
  MAX_FILE_SIZE,
  MAX_BATCH_FILE_SIZE,
} from '#middleware/upload.middleware.js';

export const errorHandler = (err, req, res, _next) => {
  // Log the error
  logger.error('[Error Handler]', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    statusCode: err.statusCode || 500,
  });

  // Zod validation errors
  if (err.name === 'ZodError') {
    return res.status(400).json({
      success: false,
      error: 'Validation error',
      details: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  // Multer rejections never reach the upload controller's try/catch — they are
  // raised by the middleware itself — so without this branch an oversized file
  // or a bad mime type fell through to the 500 default below.
  if (err.name === 'MulterError') {
    const multerStatus = {
      LIMIT_FILE_SIZE: 413,
      LIMIT_FILE_COUNT: 400,
      LIMIT_PART_COUNT: 400,
      LIMIT_FIELD_KEY: 400,
      LIMIT_FIELD_VALUE: 413,
      LIMIT_FIELD_COUNT: 400,
      LIMIT_UNEXPECTED_FILE: 400,
    };
    // The two upload routes carry different per-file ceilings, and `err.field`
    // is the only thing distinguishing them here ('file' vs 'files'), so quote
    // the limit that actually applied rather than a single hardcoded number.
    const sizeLimitMb =
      err.field === 'files'
        ? MAX_BATCH_FILE_SIZE / (1024 * 1024)
        : MAX_FILE_SIZE / (1024 * 1024);

    const multerMessage = {
      LIMIT_FILE_SIZE: `File is too large. Maximum size is ${sizeLimitMb}MB${
        err.field === 'files' ? ' per file in a batch upload' : ''
      }.`,
      LIMIT_FILE_COUNT: `Too many files. Maximum is ${MAX_FILES} per request.`,
      LIMIT_UNEXPECTED_FILE: `Unexpected file field "${err.field}".`,
    };

    return res.status(multerStatus[err.code] || 400).json({
      success: false,
      error: multerMessage[err.code] || err.message,
    });
  }

  // Database errors
  if (err.name === 'NeonDbError') {
    return res.status(500).json({
      success: false,
      error: 'Database error',
      message:
        process.env.NODE_ENV === 'development'
          ? err.message
          : 'Internal server error',
    });
  }

  // Session/Auth errors
  if (err.statusCode === 401 || err.status === 401) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      message:
        process.env.NODE_ENV === 'development'
          ? err.message
          : 'Please log in to continue',
    });
  }

  // Authorization errors
  if (err.statusCode === 403 || err.status === 403) {
    return res.status(403).json({
      success: false,
      error: 'Access denied',
      message:
        process.env.NODE_ENV === 'development'
          ? err.message
          : 'You do not have permission to access this resource',
    });
  }

  // Default error response
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
