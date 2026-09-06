import {
  uploadFile,
  uploadMultipleFiles,
  deleteFileById,
  getFileById,
  getOptimizedUrl,
  getResponsiveUrls,
  getFilesByFolder,
  listFiles,
} from '#services/upload.service.js';
import {
  uploadSingleSchema,
  uploadMultipleSchema,
  deleteFileSchema,
  getOptimizedImageSchema,
} from '#validations/upload.validation.js';
import logger from '#config/logger.js';
import { z } from 'zod';
import { validate as uuidValidate } from 'uuid';
import {
  APIConnectionTimeoutError,
  APIConnectionError,
  RateLimitError,
  AuthenticationError,
  PermissionDeniedError,
  BadRequestError,
} from '@imagekit/nodejs';

// ✅ Helper function to validate folder names
const isValidFolderName = (folder) => {
  // Allow alphanumeric, hyphens, underscores
  const folderRegex = /^[a-zA-Z0-9_-]+$/;
  return folderRegex.test(folder);
};

/**
 * Translate an ImageKit SDK failure into an HTTP status the admin UI can act on.
 *
 * Every one of these used to surface as a bare 500, which is why the browser
 * only ever showed "Request failed with status code 500" — the upstream reason
 * (a timeout, a rate limit, bad credentials) never made it to the client.
 */
const uploadErrorResponse = (rawError) => {
  // uploadMultipleFiles wraps the first failure to add batch context, so the
  // typed SDK error lives on `cause`.
  const error = rawError?.cause ?? rawError;

  if (error instanceof APIConnectionTimeoutError) {
    return {
      status: 504,
      error:
        'Upload timed out reaching the image host. Check your connection and try again.',
    };
  }
  if (error instanceof APIConnectionError) {
    return {
      status: 502,
      error: 'Could not reach the image host. Please try again.',
    };
  }
  if (error instanceof RateLimitError) {
    return {
      status: 429,
      error: 'Image host rate limit reached. Please wait and try again.',
    };
  }
  if (
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError
  ) {
    // A server-side misconfiguration, not the caller's fault — don't leak the
    // upstream text, but make it unmistakable in the logs.
    logger.error(
      '[ImageKit] Credentials rejected. Verify IMAGEKIT_PRIVATE_KEY for this NODE_ENV.',
      { upstream: error.message }
    );
    return {
      status: 502,
      error: 'Image host rejected our credentials. This is a server problem.',
    };
  }
  if (error instanceof BadRequestError) {
    // ImageKit's own validation text ("file size exceeds…"), safe and useful.
    return { status: 400, error: error.message };
  }
  // Unrecognised — most often a Postgres/Drizzle failure from the insert that
  // follows the upload, whose message can carry SQL, column names or a
  // connection string. Don't hand that to the client. The caller logs the full
  // message and stack against `requestId`, which is returned below so an admin
  // can quote it and we can find the exact line.
  return { status: 500, error: 'Upload failed due to an internal error.' };
};

export const uploadSingle = async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);

  try {
    // ✅ Validate file is provided first
    if (!req.file) {
      logger.warn(`[${requestId}] No file provided`);
      return res.status(400).json({
        success: false,
        error: 'No file provided',
      });
    }

    // ✅ Validate request body with Zod - using safeParse instead of parse
    const validationResult = uploadSingleSchema.safeParse({ body: req.body });

    if (!validationResult.success) {
      const firstError = validationResult.error.issues[0];
      logger.warn(`[${requestId}] Validation failed:`, firstError);
      return res.status(400).json({
        success: false,
        error: firstError.message,
      });
    }

    const { folder, tags } = validationResult.data.body;

    logger.info(`[${requestId}] Starting file upload`, {
      folder,
      tags,
      originalName: req.file.originalname,
    });

    const fileRecord = await uploadFile(req.file, {
      folder,
      tags,
      userId: req.user?.id,
    });

    logger.info(`[${requestId}] Upload successful - File ID: ${fileRecord.id}`);

    res.status(201).json({
      success: true,
      data: {
        id: fileRecord.id,
        fileId: fileRecord.fileId,
        fileName: fileRecord.fileName,
        originalName: fileRecord.originalName,
        url: fileRecord.url,
        thumbnailUrl: fileRecord.thumbnailUrl,
        folder: fileRecord.folder,
        fileType: fileRecord.fileType,
        size: fileRecord.size,
        tags: fileRecord.tags,
        createdAt: fileRecord.createdAt,
      },
    });
  } catch (error) {
    const { status, error: message } = uploadErrorResponse(error);
    logger.error(`[${requestId}] Upload error (${status}): ${error.message}`, {
      error: error.stack,
    });
    res.status(status).json({
      success: false,
      error: message,
      requestId,
    });
  }
};

export const uploadMultiple = async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);

  try {
    if (!req.files || req.files.length === 0) {
      logger.warn(`[${requestId}] No files provided`);
      return res.status(400).json({
        success: false,
        error: 'No files provided',
      });
    }

    // ✅ Use safeParse
    const validationResult = uploadMultipleSchema.safeParse({ body: req.body });

    if (!validationResult.success) {
      const firstError = validationResult.error.issues[0];
      logger.warn(`[${requestId}] Validation failed:`, firstError);
      return res.status(400).json({
        success: false,
        error: firstError.message,
      });
    }

    const { folder, tags } = validationResult.data.body;

    logger.info(`[${requestId}] Starting multiple upload`, {
      fileCount: req.files.length,
      folder,
      tags,
    });

    const fileRecords = await uploadMultipleFiles(req.files, {
      folder,
      tags,
      userId: req.user?.id,
    });

    logger.info(
      `[${requestId}] Multiple upload successful - ${fileRecords.length} files`
    );

    res.status(201).json({
      success: true,
      data: fileRecords.map((file) => ({
        id: file.id,
        fileId: file.fileId,
        fileName: file.fileName,
        originalName: file.originalName,
        url: file.url,
        thumbnailUrl: file.thumbnailUrl,
        folder: file.folder,
        fileType: file.fileType,
        size: file.size,
        tags: file.tags,
        createdAt: file.createdAt,
      })),
    });
  } catch (error) {
    const { status, error: message } = uploadErrorResponse(error);
    logger.error(
      `[${requestId}] Multiple upload error (${status}): ${error.message}`,
      { error: error.stack }
    );
    res.status(status).json({
      success: false,
      error: message,
      requestId,
    });
  }
};

export const deleteFile = async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);

  try {
    const { id } = req.params;

    // ✅ Validate UUID format before hitting database
    if (!uuidValidate(id)) {
      logger.warn(`[${requestId}] Invalid UUID format: ${id}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid file ID format. Must be a valid UUID.',
      });
    }

    // ✅ Validate with Zod schema
    let _validatedData;
    try {
      _validatedData = deleteFileSchema.parse({ params: req.params });
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        logger.warn(`[${requestId}] Validation failed`, validationError.issues);
        return res.status(400).json({
          success: false,
          error: 'Validation error',
          errors: validationError.issues.map((err) => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      throw validationError;
    }

    logger.info(`[${requestId}] Deleting file - ID: ${id}`);

    await deleteFileById(id);

    logger.info(`[${requestId}] File deleted successfully`);

    res.json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error) {
    logger.error(`[${requestId}] Delete error: ${error.message}`, {
      error: error.stack,
    });

    if (error.message === 'File not found') {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

export const getFile = async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);

  try {
    const { id } = req.params;

    // ✅ Validate UUID format
    if (!uuidValidate(id)) {
      logger.warn(`[${requestId}] Invalid UUID format: ${id}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid file ID format. Must be a valid UUID.',
      });
    }

    logger.debug(`[${requestId}] Fetching file - ID: ${id}`);

    const { data, cached } = await getFileById(id);

    res.json({
      success: true,
      data,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error(`[${requestId}] Get file error: ${error.message}`, {
      error: error.stack,
    });
    res.status(404).json({
      success: false,
      error: error.message,
    });
  }
};

export const getOptimizedImage = async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);

  try {
    const { id } = req.params;

    // ✅ Validate UUID format
    if (!uuidValidate(id)) {
      logger.warn(`[${requestId}] Invalid UUID format: ${id}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid file ID format. Must be a valid UUID.',
      });
    }

    // ✅ Validate with Zod schema
    let validatedData;
    try {
      validatedData = getOptimizedImageSchema.parse({
        params: req.params,
        query: req.query,
      });
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        logger.warn(`[${requestId}] Validation failed`, validationError.issues);
        return res.status(400).json({
          success: false,
          error: 'Validation error',
          errors: validationError.issues.map((err) => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      throw validationError;
    }

    const { width, height, quality, format } = validatedData.query;

    logger.debug(`[${requestId}] Getting optimized image - ID: ${id}`);

    const { data: file } = await getFileById(id);

    if (!file.fileType || !file.fileType.startsWith('image')) {
      logger.warn(
        `[${requestId}] File is not an image - Type: ${file.fileType}`
      );
      return res.status(400).json({
        success: false,
        error: 'File is not an image',
      });
    }

    const optimizedUrl = getOptimizedUrl(file.url, {
      width,
      height,
      quality,
      format,
    });

    res.json({
      success: true,
      data: { url: optimizedUrl },
    });
  } catch (error) {
    logger.error(`[${requestId}] Get optimized image error: ${error.message}`, {
      error: error.stack,
    });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

export const getResponsiveImages = async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);

  try {
    const { id } = req.params;

    // ✅ Validate UUID format
    if (!uuidValidate(id)) {
      logger.warn(`[${requestId}] Invalid UUID format: ${id}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid file ID format. Must be a valid UUID.',
      });
    }

    logger.debug(`[${requestId}] Getting responsive images - ID: ${id}`);

    const { data: file } = await getFileById(id);

    if (!file.fileType || !file.fileType.startsWith('image')) {
      logger.warn(
        `[${requestId}] File is not an image - Type: ${file.fileType}`
      );
      return res.status(400).json({
        success: false,
        error: 'File is not an image',
      });
    }

    const urls = getResponsiveUrls(file.url);

    res.json({
      success: true,
      data: urls,
    });
  } catch (error) {
    logger.error(
      `[${requestId}] Get responsive images error: ${error.message}`,
      { error: error.stack }
    );
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

/**
 * Backs the admin media library, which lists every upload rather than one
 * folder. Response shape follows the tours list ({ success, data, count, page,
 * limit }) plus `total`, so the grid can page without a second request.
 */
export const listFilesController = async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);

  try {
    const { search, type, folder } = req.query;

    if (folder && !isValidFolderName(folder)) {
      logger.warn(`[${requestId}] Invalid folder name: ${folder}`);
      return res.status(400).json({
        success: false,
        error:
          'Invalid folder name. Use only alphanumeric characters, hyphens, and underscores.',
      });
    }

    // Clamped rather than trusted: an unbounded limit would pull the whole
    // table into memory and serialize it.
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const { files: results, total } = await listFiles({
      search,
      type,
      folder,
      page,
      limit,
    });

    logger.info(`[${requestId}] Listed ${results.length} of ${total} files`);

    res.json({
      success: true,
      data: results,
      count: results.length,
      total,
      page,
      limit,
    });
  } catch (error) {
    logger.error(`[${requestId}] List files error: ${error.message}`, {
      error: error.stack,
    });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

export const getFilesByFolderController = async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);

  try {
    const { folder } = req.params;

    // ✅ Validate folder name format
    if (!isValidFolderName(folder)) {
      logger.warn(`[${requestId}] Invalid folder name: ${folder}`);
      return res.status(400).json({
        success: false,
        error:
          'Invalid folder name. Use only alphanumeric characters, hyphens, and underscores.',
      });
    }

    logger.info(`[${requestId}] Fetching files from folder: ${folder}`);

    const { data: files, cached } = await getFilesByFolder(folder);

    logger.info(
      `[${requestId}] Found ${files.length} files in folder: ${folder}`
    );

    res.json({
      success: true,
      data: files,
      count: files.length,
      ...(cached && { cached: true }),
    });
  } catch (error) {
    logger.error(`[${requestId}] Get files by folder error: ${error.message}`, {
      error: error.stack,
    });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};
