// src/services/upload.service.js
import imagekit, { urlEndpoint } from '#config/imagekit.js';
import { toFile } from '@imagekit/nodejs';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { files } from '#models/file.model.js';
import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { cache } from '#utils/cache.js';
import { CacheKeys } from '#utils/cacheKeys.js';
import { invalidateFile } from '#utils/cacheInvalidation.js';
import { withRetry } from '#utils/dbRetry.js';
import logger from '#config/logger.js';

// Helper: Generate unique filename
const generateUniqueFileName = (originalName) => {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 8);
  const extension = originalName.split('.').pop();
  const nameWithoutExt = originalName.replace(`.${extension}`, '');
  return `${nameWithoutExt}-${timestamp}-${randomString}.${extension}`;
};

/**
 * Upload single file to ImageKit and save to database
 */
export const uploadFile = async (file, options = {}) => {
  const { folder = 'general', tags = [], userId = null } = options;

  try {
    // Generated once per request, so the SDK's internal retries reuse the same
    // name. Combined with useUniqueFileName:false and ImageKit's default
    // overwriteFile:true, a retry overwrites its own partial upload rather than
    // leaving a duplicate behind.
    const uniqueFileName = generateUniqueFileName(file.originalname);

    // No `transformation.pre` here on purpose. A pre-transformation is applied
    // synchronously before the upload API responds, so it added latency to the
    // call that was already timing out, and it permanently re-encoded the
    // stored master. Sizing and format are delivery-time concerns — the client
    // requests them per breakpoint via a `tr:` path segment.
    const result = await imagekit.files.upload({
      // toFile does not infer a MIME type from the extension, and an untyped
      // body leaves ImageKit to sniff it — pass what multer already parsed.
      file: await toFile(file.buffer, uniqueFileName, { type: file.mimetype }),
      fileName: uniqueFileName,
      folder: `footlooseadventures/${folder}`,
      useUniqueFileName: false,
      tags: [folder, ...tags],
      // v7 returns hasTransparency/exif under `metadata`, which is omitted
      // unless asked for. Costs no extra round trip.
      responseFields: ['metadata'],
    });

    // The remote upload has already happened. If the row insert fails the
    // file stays in ImageKit with nothing pointing at it and nothing to find
    // it by, so remove it before propagating the original error.
    let fileRecord;
    try {
      [fileRecord] = await withTenantDb((tx) =>
        tx
          .insert(files)
          .values({
            tenant_id: currentTenantId(),
            fileId: result.fileId,
            fileName: result.name,
            originalName: file.originalname,
            url: result.url,
            thumbnailUrl: result.thumbnailUrl || null,
            folder,
            fileType: file.mimetype.split('/')[0],
            mimeType: file.mimetype,
            size: result.size || file.size,
            // ImageKit measures the image during upload, so these come free with
            // the response — no sharp, no second decode. Null for video/raw, where
            // ImageKit reports no dimensions.
            width: result.width ?? null,
            height: result.height ?? null,
            tags: [folder, ...tags],
            metadata: {
              hasAlpha: result.metadata?.hasTransparency ?? null,
              orientation: result.metadata?.exif?.image?.Orientation ?? null,
            },
            uploadedBy: userId,
          })
          .returning()
      );
    } catch (dbError) {
      // The file is already in ImageKit. Nothing references it and nothing can
      // find it again, so it would sit there costing storage forever.
      try {
        await imagekit.files.delete(result.fileId);
      } catch (cleanupError) {
        logger.error('Failed to remove orphaned ImageKit file', {
          fileId: result.fileId,
          error: cleanupError.message,
        });
      }
      // The insert failure is the real error; cleanup is best effort.
      throw dbError;
    }

    // Invalidate caches after upload
    await cache.del(CacheKeys.filesByFolder(folder));

    logger.info('File uploaded successfully:', {
      id: fileRecord.id,
      fileId: fileRecord.fileId,
      folder,
    });

    return fileRecord;
  } catch (error) {
    logger.error('Failed to upload file:', error);
    throw error;
  }
};

/**
 * Upload multiple files with transaction-like behavior
 */

export const uploadMultipleFiles = async (filesArray, options = {}) => {
  const results = await Promise.allSettled(
    filesArray.map((file) => uploadFile(file, options))
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');

  if (failed.length > 0) {
    logger.error(
      `${failed.length} of ${filesArray.length} uploads failed, rolling back ${succeeded.length} successful upload(s)...`,
      failed.map((r) => r.reason?.message)
    );

    const uploadedFileIds = succeeded.map((r) => r.value.fileId);

    const rollbackResults = await Promise.allSettled(
      uploadedFileIds.map((fileId) => deleteFile(fileId))
    );

    const rolledBack = rollbackResults.filter(
      (r) => r.status === 'fulfilled'
    ).length;

    logger.warn(`Rolled back ${rolledBack} of ${uploadedFileIds.length} files`);

    // Keep the original as `cause` so the controller can still tell a timeout
    // from a rate limit from bad credentials — wrapping it in a plain Error
    // flattened every batch failure into a 500.
    const firstError = failed[0].reason;
    throw new Error(
      `Upload failed: ${firstError?.message || 'Unknown error'}`,
      {
        cause: firstError,
      }
    );
  }

  const uploadedFiles = succeeded.map((r) => r.value);
  logger.info(`Successfully uploaded ${uploadedFiles.length} files`);
  return uploadedFiles;
};

/**
 * Delete file from ImageKit and database
 */
const deleteFile = async (fileId) => {
  try {
    await imagekit.files.delete(fileId);
    await withTenantDb((tx) =>
      tx.delete(files).where(eq(files.fileId, fileId))
    );

    logger.info(`File deleted: ${fileId}`);
    return { success: true, fileId };
  } catch (error) {
    logger.error(`Failed to delete file ${fileId}:`, error);
    throw error;
  }
};

/**
 * Delete file by database ID (with cache invalidation)
 */

export const deleteFileById = async (id) => {
  try {
    const [fileRecord] = await withRetry(() => {
      return withTenantDb((tx) =>
        tx.select().from(files).where(eq(files.id, id))
      );
    });

    if (!fileRecord) {
      throw new Error('File not found');
    }

    // ✅ Try to delete from ImageKit, but don't fail if it's already gone
    try {
      await deleteFile(fileRecord.fileId);
    } catch (imagekitError) {
      logger.warn(
        `ImageKit delete failed (file may not exist): ${imagekitError.message}`
      );
      // Continue anyway - we still want to delete from our DB
    }

    // Always delete from database
    await withTenantDb((tx) => tx.delete(files).where(eq(files.id, id)));

    // Invalidate caches
    await invalidateFile(fileRecord.id, fileRecord.folder);

    logger.info(`File deleted by ID: ${id}`, {
      folder: fileRecord.folder,
    });

    return { success: true };
  } catch (error) {
    logger.error(`Failed to delete file by ID ${id}:`, error);
    throw error;
  }
};

/**
 * Get file by ID (with caching and retry)
 */
export const getFileById = async (id) => {
  try {
    const cacheKey = CacheKeys.file(id);

    return await cache.wrap(cacheKey, 3600, () => {
      return withRetry(async () => {
        const [file] = await withTenantDb((tx) =>
          tx.select().from(files).where(eq(files.id, id))
        );

        if (!file) {
          throw new Error('File not found');
        }

        return file;
      });
    });
  } catch (error) {
    logger.error(`Failed to get file by ID ${id}:`, error);
    throw error;
  }
};

/**
 * Get files by folder (with caching and retry)
 */
export const getFilesByFolder = async (folder) => {
  try {
    const cacheKey = CacheKeys.filesByFolder(folder);

    return await cache.wrap(cacheKey, 1800, () => {
      return withRetry(async () => {
        const folderFiles = await withTenantDb((tx) =>
          tx
            .select()
            .from(files)
            .where(eq(files.folder, folder))
            .orderBy(files.createdAt)
        );

        logger.info(`Found ${folderFiles.length} files in folder: ${folder}`);
        return folderFiles;
      });
    });
  } catch (error) {
    logger.error(`Failed to get files by folder ${folder}:`, error);
    throw error;
  }
};

/**
 * The API speaks snake_case on the wire (see formatTourResponse in
 * tour.service.js), but this model declares camelCase property names, so rows
 * come off Drizzle in a shape no client expects. Map explicitly rather than
 * running a generic converter: the admin media library reads these exact keys,
 * and a blanket rename would quietly reshape the payload on the next schema
 * change instead of failing where someone would notice.
 */
export const formatFileResponse = (file) => ({
  id: file.id,
  file_id: file.fileId,
  file_name: file.fileName,
  original_name: file.originalName,
  url: file.url,
  thumbnail_url: file.thumbnailUrl,
  folder: file.folder,
  file_type: file.fileType,
  mime_type: file.mimeType,
  size: file.size,
  width: file.width,
  height: file.height,
  tags: file.tags,
  metadata: file.metadata,
  uploaded_by: file.uploadedBy,
  created_at: file.createdAt,
  updated_at: file.updatedAt,
});

/**
 * List files for the admin media library, with optional search/type/folder
 * filters and pagination.
 *
 * Deliberately uncached, unlike getFilesByFolder above: the filter combinations
 * would explode the key space, and an admin who has just uploaded or deleted
 * something expects the grid to reflect it immediately. This is an admin-only
 * endpoint, so the read volume does not justify the staleness.
 */
export const listFiles = async ({
  search,
  type,
  folder,
  page = 1,
  limit = 50,
} = {}) => {
  try {
    const conditions = [];

    if (search) {
      // fileName carries the generated name and originalName what the admin
      // actually uploaded; matching both is what makes search feel right.
      const pattern = `%${search}%`;
      conditions.push(
        or(ilike(files.fileName, pattern), ilike(files.originalName, pattern))
      );
    }
    if (type) conditions.push(eq(files.fileType, type));
    if (folder) conditions.push(eq(files.folder, folder));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return await withRetry(() =>
      withTenantDb(async (tx) => {
        const rows = await tx
          .select()
          .from(files)
          .where(where)
          .orderBy(desc(files.createdAt))
          .limit(limit)
          .offset((page - 1) * limit);

        // Separate count so the caller can page: rows is only the current
        // slice.
        //
        // Sharing a transaction does NOT make the total agree with the rows,
        // which the previous comment here claimed. withTenantDb opens at the
        // default READ COMMITTED, where each statement takes its own snapshot,
        // so an upload committing between these two queries is visible to one
        // and not the other. REPEATABLE READ would settle it but cannot be set
        // from here: withTenantDb has already issued set_config on this
        // transaction, and SET TRANSACTION ISOLATION LEVEL must precede every
        // statement. Left alone deliberately -- a file listing whose total is
        // briefly one out does not justify a stricter isolation level on every
        // tenant query.
        const [totals] = await tx
          .select({ total: count() })
          .from(files)
          .where(where);

        return {
          files: rows.map(formatFileResponse),
          total: Number(totals?.total ?? 0),
        };
      })
    );
  } catch (error) {
    logger.error(`Failed to list files:`, error);
    throw error;
  }
};

/**
 * Delete multiple files (batch operation)
 */
export const deleteMultipleFiles = async (fileIds) => {
  const results = await Promise.allSettled(
    fileIds.map((id) => deleteFileById(id))
  );

  const deleted = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  logger.info(`Batch delete completed: ${deleted} deleted, ${failed} failed`);

  return {
    deleted,
    failed,
    results: results.map((r) =>
      r.status === 'fulfilled' ? r.value : r.reason
    ),
  };
};

/**
 * Update file metadata (with cache invalidation)
 */
export const updateFileMetadata = async (id, updates) => {
  try {
    const [updated] = await withTenantDb((tx) =>
      tx
        .update(files)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(files.id, id))
        .returning()
    );

    if (updated) {
      // Invalidate caches
      await invalidateFile(
        updated.id,
        updated.folder,
        updated.entityType,
        updated.entityId
      );

      logger.info(`File metadata updated: ${id}`);
    }

    return updated || null;
  } catch (error) {
    logger.error(`Failed to update file metadata ${id}:`, error);
    throw error;
  }
};

/**
 * Get optimized image URL (no caching needed - URL generation)
 */
export const getOptimizedUrl = (filePath, options = {}) => {
  const { width = 800, height = 600, quality = 80, format = 'auto' } = options;

  // `src` — not `path` — is what accepts an already-absolute URL. Callers pass
  // the full stored `file.url`; under `path` the builder treated it as relative
  // to urlEndpoint and joined the two, emitting
  // `https://ik.imagekit.io/<id>/tr:.../https:/ik.imagekit.io/<id>/...`.
  // Emits the query form (`?tr=w-800,...`) because src is absolute; the client
  // loader emits the path form. Both are valid ImageKit and equivalent.
  return imagekit.helper.buildSrc({
    src: filePath,
    urlEndpoint,
    transformation: [{ width, height, quality, format }],
  });
};

/**
 * Get responsive image URLs (no caching needed - URL generation)
 */
export const getResponsiveUrls = (filePath) => {
  return {
    thumbnail: getOptimizedUrl(filePath, {
      width: 150,
      height: 150,
      quality: 70,
    }),
    small: getOptimizedUrl(filePath, { width: 400, height: 300, quality: 75 }),
    medium: getOptimizedUrl(filePath, { width: 800, height: 600, quality: 80 }),
    large: getOptimizedUrl(filePath, { width: 1200, height: 900, quality: 85 }),
    original: filePath,
  };
};
