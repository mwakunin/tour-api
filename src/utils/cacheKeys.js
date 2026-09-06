// src/utils/cacheKeys.js
/**
 * Centralized cache key management
 * Prevents typos and makes cache invalidation easier
 */

/**
 * Helper to create deterministic filter string
 * More readable than base64 for debugging
 */
const serializeFilters = (filters = {}) => {
  const sorted = Object.keys(filters)
    .filter((key) => filters[key] !== undefined && filters[key] !== null)
    .sort()
    .map((key) => {
      const value = filters[key];
      // Handle different types
      if (typeof value === 'object') {
        return `${key}=${JSON.stringify(value)}`;
      }
      return `${key}=${value}`;
    })
    .join('|');

  return sorted || 'default';
};

export const CacheKeys = {
  // ============= DESTINATIONS =============
  destination: (id) => `destination:${id}`,

  destinationSlug: (slug) => `destination:slug:${slug}`,

  destinationsList: (filters = {}) => {
    const filterStr = serializeFilters(filters);
    return `destinations:list:${filterStr}`;
  },

  destinationTours: (destinationId) => `destination:${destinationId}:tours`,

  destinationStats: (destinationId) => `destination:${destinationId}:stats`,

  destinationRevenue: () => 'destinations:revenue:breakdown',

  // ============= TOURS =============
  tour: (id) => `tour:${id}`,

  tourSlug: (slug) => `tour:slug:${slug}`,

  toursList: (filters = {}) => {
    const filterStr = serializeFilters(filters);
    return `tours:list:${filterStr}`;
  },

  tourFull: (id) => `tour:full:${id}`, // Tour with destination

  tourStats: (id) => `tour:stats:${id}`,

  toursFeatured: (limit = 6) => `tours:featured:${limit}`,

  toursDeals: (limit = 10) => `tours:deals:${limit}`,

  toursSearch: (query) => `tours:search:${query.toLowerCase().trim()}`,

  toursTopPerforming: (metric = 'bookings') => `tours:top:${metric}`,

  topTours: (metric) => `tour:top:${metric}`,

  // ============= BOOKINGS =============
  booking: (id) => `booking:${id}`,

  bookingReference: (reference) => `booking:ref:${reference}`,

  bookingsList: (filters = {}) => {
    const filterStr = serializeFilters(filters);
    return `bookings:list:${filterStr}`;
  },

  userBookings: (userId, filters = {}) => {
    const { status = 'all', limit = 10, page = 1 } = filters;
    return `bookings:user:${userId}:status=${status}|limit=${limit}|page=${page}`;
  },

  tourBookings: (tourId) => `bookings:tour:${tourId}`,

  bookingStats: () => 'bookings:stats',

  bookingTrends: () => 'bookings:trends',

  revenueStats: () => 'bookings:revenue:stats',

  // ============= USERS =============
  user: (id) => `user:${id}`,

  userProfile: (id) => `user:profile:${id}`,

  userByEmail: (email) => `user:email:${email.toLowerCase()}`,

  userByKindeId: (kindeId) => `user:kinde:${kindeId}`,

  // ============= FILES =============
  file: (id) => `file:${id}`,

  filesByFolder: (folder) => `files:folder:${folder}`,

  filesByEntity: (entityType, entityId) => `files:${entityType}:${entityId}`,

  // ============= BLOG =============
  blogPost: (id) => `blog:post:${id}`,

  blogPostSlug: (slug) => `blog:post:slug:${slug}`,

  blogPostsList: (filters = {}) => {
    const filterStr = serializeFilters(filters);
    return `blog:posts:list:${filterStr}`;
  },

  blogCategories: () => 'blog:categories',

  blogCategory: (id) => `blog:category:${id}`,

  blogPostsByCategory: (categoryId, filters = {}) => {
    const filterStr = serializeFilters(filters);
    return `blog:posts:category:${categoryId}:${filterStr}`;
  },

  blogFeaturedPosts: (limit = 3) => `blog:featured:${limit}`,

  blogRecentPosts: (limit = 5) => `blog:recent:${limit}`,

  blogPopularPosts: (limit = 5) => `blog:popular:${limit}`,

  // ============= STATS/ANALYTICS =============
  stats: {
    dashboard: () => 'stats:dashboard',
    dashboardAdmin: () => 'stats:dashboard:admin',
    bookingsCount: () => 'stats:bookings:count',
    revenue: (period = 'month') => `stats:revenue:${period}`,
    tourPopularity: () => 'stats:tours:popular',
    destinationPopularity: () => 'stats:destinations:popular',
  },

  // ============= CACHE PATTERNS (for invalidation) =============
  patterns: {
    // Tour patterns
    allTours: () => 'tour*',
    tourLists: () => 'tours:list:*',
    toursFeatured: () => 'tours:featured:*',
    toursDeals: () => 'tours:deals:*',
    toursSearch: () => 'tours:search:*',
    toursTop: () => 'tours:top:*',

    // Destination patterns
    allDestinations: () => 'destination*',
    destinationLists: () => 'destinations:list:*',

    // Booking patterns
    allBookings: () => 'booking*',
    bookingLists: () => 'bookings:list:*',
    userBookings: (userId) => `bookings:user:${userId}:*`,
    bookingTrends: () => 'bookings:trends',
    revenueStats: () => 'bookings:revenue:*',

    // Blog patterns
    allBlogPosts: () => 'blog:post*',
    blogPostsLists: () => 'blog:posts:list:*',
    blogFeatured: () => 'blog:featured:*',
    blogRecent: () => 'blog:recent:*',
    blogPopular: () => 'blog:popular:*',
    allBlogCategories: () => 'blog:categor*',

    // User patterns
    allUsers: () => 'user*',

    // File patterns
    allFiles: () => 'file*',

    // Stats patterns
    allStats: () => 'stats:*',
  },
};

// ============= HELPER FUNCTIONS =============

/**
 * Get all cache keys for a specific tour (for targeted invalidation)
 */
export const getTourCacheKeys = (tourId, slug, destinationId) => {
  const keys = [
    CacheKeys.tour(tourId),
    CacheKeys.tourFull(tourId),
    CacheKeys.tourStats(tourId),
    CacheKeys.tourBookings(tourId),
  ];

  if (slug) {
    keys.push(CacheKeys.tourSlug(slug));
  }

  if (destinationId) {
    keys.push(CacheKeys.destinationTours(destinationId));
    keys.push(CacheKeys.destinationStats(destinationId));
  }

  return keys;
};

/**
 * Get all cache keys for a specific destination
 */
export const getDestinationCacheKeys = (destinationId, slug) => {
  const keys = [
    CacheKeys.destination(destinationId),
    CacheKeys.destinationTours(destinationId),
    CacheKeys.destinationStats(destinationId),
  ];

  if (slug) {
    keys.push(CacheKeys.destinationSlug(slug));
  }

  return keys;
};

/**
 * Get all cache keys for a specific booking
 */
export const getBookingCacheKeys = (bookingId, userId, tourId, reference) => {
  const keys = [CacheKeys.booking(bookingId)];

  if (reference) {
    keys.push(CacheKeys.bookingReference(reference));
  }

  if (tourId) {
    keys.push(CacheKeys.tourBookings(tourId));
    keys.push(CacheKeys.tourStats(tourId));
  }

  return keys.filter(Boolean);
};

/**
 * Get all cache keys for a specific user
 */
export const getUserCacheKeys = (userId, email, kindeId) => {
  const keys = [CacheKeys.user(userId), CacheKeys.userProfile(userId)];

  if (email) {
    keys.push(CacheKeys.userByEmail(email));
  }

  if (kindeId) {
    keys.push(CacheKeys.userByKindeId(kindeId));
  }

  return keys;
};

/**
 * Get all cache keys for a file
 */
export const getFileCacheKeys = (fileId, folder, entityType, entityId) => {
  const keys = [CacheKeys.file(fileId)];

  if (folder) {
    keys.push(CacheKeys.filesByFolder(folder));
  }

  if (entityType && entityId) {
    keys.push(CacheKeys.filesByEntity(entityType, entityId));
  }

  return keys;
};

/**
 * Get all cache keys for a specific blog post
 */
export const getBlogPostCacheKeys = (postId, slug, categoryId) => {
  const keys = [
    CacheKeys.blogPost(postId),
    CacheKeys.blogFeaturedPosts(),
    CacheKeys.blogRecentPosts(),
    CacheKeys.blogPopularPosts(),
  ];

  if (slug) {
    keys.push(CacheKeys.blogPostSlug(slug));
  }

  if (categoryId) {
    keys.push(CacheKeys.blogPostsByCategory(categoryId));
  }

  return keys;
};

/**
 * Get all cache keys for blog categories
 */
export const getBlogCategoryCacheKeys = (categoryId) => {
  const keys = [CacheKeys.blogCategories()];

  if (categoryId) {
    keys.push(CacheKeys.blogCategory(categoryId));
  }

  return keys;
};
