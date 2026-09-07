// src/utils/cacheInvalidation.js
import { cache } from './cache.js';
import {
  CacheKeys,
  getTourCacheKeys,
  getDestinationCacheKeys,
  getBookingCacheKeys,
  getUserCacheKeys,
  getFileCacheKeys,
  getBlogPostCacheKeys,
  getBlogCategoryCacheKeys,
} from './cacheKeys.js';
import logger from '#config/logger.js';

/**
 * Invalidate all destination-related caches
 */
export const invalidateDestination = async (destinationId, slug) => {
  try {
    // Delete specific destination caches using helper
    const specificKeys = getDestinationCacheKeys(destinationId, slug);
    await cache.delMany(specificKeys);

    // Delete all destination lists
    await cache.delPattern(CacheKeys.patterns.destinationLists());

    // Invalidate stats that might include this destination
    await cache.delPattern(CacheKeys.patterns.allStats());

    logger.info('[Cache Invalidation] Destination caches cleared:', {
      destinationId,
      slug,
      keysCleared: specificKeys.length,
    });
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to invalidate destination:',
      error.message
    );
  }
};

/**
 * Invalidate all tour-related caches
 */
export const invalidateTour = async (tourId, slug, destinationId = null) => {
  try {
    // Delete specific tour caches using helper
    const specificKeys = getTourCacheKeys(tourId, slug, destinationId);
    await cache.delMany(specificKeys);

    // Delete all tour lists and related caches
    await cache.delPattern(CacheKeys.patterns.tourLists());
    await cache.delPattern(CacheKeys.patterns.toursFeatured());
    await cache.delPattern(CacheKeys.patterns.toursDeals());
    await cache.delPattern(CacheKeys.patterns.toursSearch());

    // If tour belongs to a destination, invalidate destination cache
    if (destinationId) {
      await cache.del(CacheKeys.destination(destinationId));
    }

    // Invalidate stats
    await cache.delPattern(CacheKeys.patterns.allStats());

    logger.info('[Cache Invalidation] Tour caches cleared:', {
      tourId,
      slug,
      destinationId,
      keysCleared: specificKeys.length,
    });
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to invalidate tour:',
      error.message
    );
  }
};

/**
 * Invalidate all booking-related caches
 */
export const invalidateBooking = async (
  bookingId,
  userId,
  tourId,
  reference
) => {
  try {
    // Delete specific booking caches using helper
    const specificKeys = getBookingCacheKeys(
      bookingId,
      userId,
      tourId,
      reference
    );
    await cache.delMany(specificKeys);

    // Delete all booking lists
    await cache.delPattern(CacheKeys.patterns.bookingLists());

    // Delete user-specific booking caches if userId provided
    if (userId) {
      await cache.delPattern(CacheKeys.patterns.userBookings(userId));
    }

    // If booking is for a tour, invalidate tour stats
    if (tourId) {
      await cache.del(CacheKeys.tourStats(tourId));
      await cache.del(CacheKeys.tourBookings(tourId));
    }

    // Both namespaces. Dashboard counters live under stats:*, but the filtered
    // booking statistics live under bookings:stats:* and revenue under
    // bookings:revenue:* -- `stats:*` matches neither, so they were never
    // cleared here and stayed stale for their full ten minutes.
    await cache.delPattern(CacheKeys.patterns.allStats());
    await cache.delPattern(CacheKeys.patterns.bookingStats());
    await cache.delPattern(CacheKeys.patterns.revenueStats());

    logger.info('[Cache Invalidation] Booking caches cleared:', {
      bookingId,
      userId,
      tourId,
      reference,
      keysCleared: specificKeys.length,
    });
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to invalidate booking:',
      error.message
    );
  }
};

/**
 * Invalidate user-related caches
 */
export const invalidateUser = async (userId, email, kindeId) => {
  try {
    // Delete specific user caches using helper
    const specificKeys = getUserCacheKeys(userId, email, kindeId);
    await cache.delMany(specificKeys);

    // Delete user's bookings cache
    await cache.delPattern(CacheKeys.patterns.userBookings(userId));

    logger.info('[Cache Invalidation] User caches cleared:', {
      userId,
      email: email ? '***' : null,
      kindeId: kindeId ? '***' : null,
      keysCleared: specificKeys.length,
    });
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to invalidate user:',
      error.message
    );
  }
};

/**
 * Invalidate all statistics caches
 */
export const invalidateStats = async () => {
  try {
    // Both namespaces. Dashboard counters live under stats:*, but the filtered
    // booking statistics live under bookings:stats:* and revenue under
    // bookings:revenue:* -- `stats:*` matches neither, so they were never
    // cleared here and stayed stale for their full ten minutes.
    await cache.delPattern(CacheKeys.patterns.allStats());
    await cache.delPattern(CacheKeys.patterns.bookingStats());
    await cache.delPattern(CacheKeys.patterns.revenueStats());
    await cache.delPattern(CacheKeys.patterns.bookingStatsAll());
    logger.info('[Cache Invalidation] All stats caches cleared');
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to invalidate stats:',
      error.message
    );
  }
};

/**
 * Invalidate file-related caches
 */
export const invalidateFile = async (fileId, folder, entityType, entityId) => {
  try {
    // Delete specific file caches using helper
    const specificKeys = getFileCacheKeys(fileId, folder, entityType, entityId);
    await cache.delMany(specificKeys);

    logger.info('[Cache Invalidation] File caches cleared:', {
      fileId,
      folder,
      entityType,
      entityId,
      keysCleared: specificKeys.length,
    });
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to invalidate file:',
      error.message
    );
  }
};

/**
 * Invalidate multiple tours at once (batch operation)
 */
export const invalidateTours = async (tourIds) => {
  try {
    const promises = tourIds.map((tourId) => invalidateTour(tourId));
    await Promise.all(promises);

    logger.info(
      `[Cache Invalidation] Batch invalidated ${tourIds.length} tours`
    );
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to batch invalidate tours:',
      error.message
    );
  }
};

/**
 * Invalidate multiple bookings at once (batch operation)
 */
export const invalidateBookings = async (bookingIds) => {
  try {
    const promises = bookingIds.map((bookingId) =>
      invalidateBooking(bookingId)
    );
    await Promise.all(promises);

    logger.info(
      `[Cache Invalidation] Batch invalidated ${bookingIds.length} bookings`
    );
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to batch invalidate bookings:',
      error.message
    );
  }
};

/**
 * Invalidate all blog post-related caches
 */
export const invalidateBlogPost = async (postId, slug, categoryId) => {
  try {
    // Delete specific blog post caches using helper
    const specificKeys = getBlogPostCacheKeys(postId, slug, categoryId);
    await cache.delMany(specificKeys);

    // Delete all blog post lists
    await cache.delPattern(CacheKeys.patterns.blogPostsLists());
    await cache.delPattern(CacheKeys.patterns.blogFeatured());
    await cache.delPattern(CacheKeys.patterns.blogRecent());
    await cache.delPattern(CacheKeys.patterns.blogPopular());

    logger.info('[Cache Invalidation] Blog post caches cleared:', {
      postId,
      slug,
      categoryId,
      keysCleared: specificKeys.length,
    });
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to invalidate blog post:',
      error.message
    );
  }
};

/**
 * Invalidate blog category caches
 */
export const invalidateBlogCategory = async (categoryId) => {
  try {
    // Delete specific category caches
    const specificKeys = getBlogCategoryCacheKeys(categoryId);
    await cache.delMany(specificKeys);

    // Delete all posts that might be filtered by this category
    await cache.delPattern(CacheKeys.patterns.blogPostsLists());

    logger.info('[Cache Invalidation] Blog category caches cleared:', {
      categoryId,
      keysCleared: specificKeys.length,
    });
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to invalidate blog category:',
      error.message
    );
  }
};

/**
 * Invalidate all blog-related caches (nuclear option)
 */
export const invalidateAllBlog = async () => {
  try {
    await cache.delPattern(CacheKeys.patterns.allBlogPosts());
    await cache.delPattern(CacheKeys.patterns.allBlogCategories());

    logger.info('[Cache Invalidation] All blog caches cleared');
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to invalidate all blog caches:',
      error.message
    );
  }
};

/**
 * Nuclear option: clear all application caches
 * Use with caution - only for maintenance or critical updates
 */
export const invalidateAll = async () => {
  try {
    await cache.flushAll();
    logger.warn(
      '[Cache Invalidation] ⚠️  ALL CACHES FLUSHED - Complete cache reset'
    );
  } catch (error) {
    logger.error(
      '[Cache Invalidation] Failed to flush all caches:',
      error.message
    );
  }
};

/**
 * Warm up critical caches after flush (optional)
 * Call this after invalidateAll() to pre-populate important data
 */
export const warmUpCache = () => {
  try {
    logger.info('[Cache Warm-up] Starting cache warm-up...');

    // This would call your service functions to pre-populate cache
    // Example:
    // await getFeaturedTours();
    // await getDeals();
    // etc.

    logger.info('[Cache Warm-up] Cache warm-up completed');
  } catch (error) {
    logger.error('[Cache Warm-up] Failed to warm up cache:', error.message);
  }
};
