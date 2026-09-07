// src/services/blog.service.js
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { blogPosts, blogCategories } from '#models/blog.model.js';
import { user } from '#models/user.model.js';
import { eq, desc, asc, and, or, sql, ilike } from 'drizzle-orm';
import logger from '#config/logger.js';
import { cache } from '#utils/cache.js';
import { CacheKeys } from '#utils/cacheKeys.js';

// ============================================
// HELPER FUNCTIONS
// ============================================

// Create slug from title
const createSlug = (title) => {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

// Calculate read time based on word count
const calculateReadTime = (content) => {
  const wordsPerMinute = 200;
  const wordCount = content.trim().split(/\s+/).length;
  return Math.ceil(wordCount / wordsPerMinute);
};

// ============================================
// BLOG POSTS
// ============================================

// Get all blog posts with filters
export const getAllBlogPosts = async (filters = {}) => {
  try {
    // Only these two are read here. The rest travel to fetchBlogPosts inside
    // normalizedFilters, so unpacking them was noise that read as though this
    // function handled paging and sorting itself.
    const { status = 'published', search } = filters;

    // Normalize search for consistent caching
    const normalizedFilters = {
      ...filters,
      search: search?.toLowerCase().trim(),
    };

    // ✅ Cache key based on filters
    const cacheKey = CacheKeys.blogPostsList(normalizedFilters);

    // ✅ Only cache published posts (not drafts for admin)
    if (status === 'published') {
      return await cache.wrap(cacheKey, 300, () =>
        fetchBlogPosts(normalizedFilters)
      );
    }

    // Don't cache admin queries (drafts, etc.)
    return await fetchBlogPosts(normalizedFilters);
  } catch (error) {
    logger.error('[Blog Service] Get all posts error:', error);
    throw error;
  }
};

// ✅ Helper function to fetch posts (used by cached and non-cached calls)
const fetchBlogPosts = async (filters) => {
  const {
    page = 1,
    limit = 10,
    status = 'published',
    category_id,
    search,
    sort_by = 'published_at',
    sort_order = 'desc',
  } = filters;

  const offset = (page - 1) * limit;

  // Build WHERE conditions
  const conditions = [];

  if (status !== 'all') {
    conditions.push(eq(blogPosts.status, status));
  }

  if (category_id) {
    conditions.push(eq(blogPosts.category_id, category_id));
  }

  if (search) {
    conditions.push(
      or(
        ilike(blogPosts.title, `%${search}%`),
        ilike(blogPosts.excerpt, `%${search}%`),
        ilike(blogPosts.content, `%${search}%`)
      )
    );
  }

  // Only show published posts with valid published_at date
  if (status === 'published') {
    conditions.push(sql`${blogPosts.published_at} IS NOT NULL`);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Sort configuration
  const sortColumn = blogPosts[sort_by] || blogPosts.published_at;
  const sortFn = sort_order === 'asc' ? asc : desc;

  // Query posts with author and category
  const posts = await withTenantDb((tx) =>
    tx
      .select({
        id: blogPosts.id,
        title: blogPosts.title,
        slug: blogPosts.slug,
        excerpt: blogPosts.excerpt,
        content: blogPosts.content,
        featured_image: blogPosts.featured_image,
        category_id: blogPosts.category_id,
        status: blogPosts.status,
        meta_title: blogPosts.meta_title,
        meta_description: blogPosts.meta_description,
        read_time_minutes: blogPosts.read_time_minutes,
        views_count: blogPosts.views_count,
        published_at: blogPosts.published_at,
        created_at: blogPosts.created_at,
        updated_at: blogPosts.updated_at,
        author: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
        category: {
          id: blogCategories.id,
          name: blogCategories.name,
          slug: blogCategories.slug,
        },
      })
      .from(blogPosts)
      .leftJoin(user, eq(blogPosts.author_id, user.id))
      .leftJoin(blogCategories, eq(blogPosts.category_id, blogCategories.id))
      .where(whereClause)
      .orderBy(sortFn(sortColumn))
      .limit(limit)
      .offset(offset)
  );

  // Get total count
  const [{ count }] = await withTenantDb((tx) =>
    tx
      .select({ count: sql`count(*)::int` })
      .from(blogPosts)
      .where(whereClause)
  );

  return {
    posts,
    pagination: {
      page,
      limit,
      total: count,
      totalPages: Math.ceil(count / limit),
    },
  };
};

// Get single blog post by slug
export const getBlogPostBySlug = async (slug, incrementViews = false) => {
  try {
    const [post] = await withTenantDb((tx) =>
      tx
        .select({
          id: blogPosts.id,
          title: blogPosts.title,
          slug: blogPosts.slug,
          excerpt: blogPosts.excerpt,
          content: blogPosts.content,
          featured_image: blogPosts.featured_image,
          category_id: blogPosts.category_id,
          author_id: blogPosts.author_id,
          status: blogPosts.status,
          meta_title: blogPosts.meta_title,
          meta_description: blogPosts.meta_description,
          read_time_minutes: blogPosts.read_time_minutes,
          views_count: blogPosts.views_count,
          published_at: blogPosts.published_at,
          created_at: blogPosts.created_at,
          updated_at: blogPosts.updated_at,
          author: {
            id: user.id,
            name: user.name,
            email: user.email,
          },
          category: {
            id: blogCategories.id,
            name: blogCategories.name,
            slug: blogCategories.slug,
          },
        })
        .from(blogPosts)
        .leftJoin(user, eq(blogPosts.author_id, user.id))
        .leftJoin(blogCategories, eq(blogPosts.category_id, blogCategories.id))
        .where(eq(blogPosts.slug, slug))
        .limit(1)
    );

    if (!post) {
      return null; // Return null instead of throwing
    }

    // Increment views if requested (for public viewing)
    if (incrementViews) {
      await withTenantDb((tx) =>
        tx
          .update(blogPosts)
          .set({
            views_count: sql`${blogPosts.views_count} + 1`,
          })
          .where(eq(blogPosts.id, post.id))
      );
    }

    return post;
  } catch (error) {
    logger.error(`[Blog Service] Get post by slug ${slug} error:`, error);
    throw error;
  }
};

// Get blog post by ID
export const getBlogPostById = async (id) => {
  try {
    const [post] = await withTenantDb((tx) =>
      tx
        .select({
          id: blogPosts.id,
          title: blogPosts.title,
          slug: blogPosts.slug,
          excerpt: blogPosts.excerpt,
          content: blogPosts.content,
          featured_image: blogPosts.featured_image,
          category_id: blogPosts.category_id,
          author_id: blogPosts.author_id,
          status: blogPosts.status,
          meta_title: blogPosts.meta_title,
          meta_description: blogPosts.meta_description,
          read_time_minutes: blogPosts.read_time_minutes,
          views_count: blogPosts.views_count,
          published_at: blogPosts.published_at,
          created_at: blogPosts.created_at,
          updated_at: blogPosts.updated_at,
          author: {
            id: user.id,
            name: user.name,
            email: user.email,
          },
          category: {
            id: blogCategories.id,
            name: blogCategories.name,
            slug: blogCategories.slug,
          },
        })
        .from(blogPosts)
        .leftJoin(user, eq(blogPosts.author_id, user.id))
        .leftJoin(blogCategories, eq(blogPosts.category_id, blogCategories.id))
        .where(eq(blogPosts.id, id))
        .limit(1)
    );

    return post || null;
  } catch (error) {
    logger.error(`[Blog Service] Get post by ID ${id} error:`, error);
    throw error;
  }
};

// Create blog post
export const createBlogPost = async (postData, authorId) => {
  try {
    // Generate slug if not provided
    const slug = postData.slug || createSlug(postData.title);

    // Calculate read time if not provided
    const read_time_minutes =
      postData.read_time_minutes || calculateReadTime(postData.content);

    // Set published_at if status is published
    const published_at =
      postData.status === 'published' && !postData.published_at
        ? new Date()
        : postData.published_at;

    const [post] = await withTenantDb((tx) =>
      tx
        .insert(blogPosts)
        .values({
          ...postData,
          // After the spread: caller-supplied input must not be able to set
          // tenant_id and write into another operator's data.
          tenant_id: currentTenantId(),
          slug,
          read_time_minutes,
          published_at,
          author_id: authorId,
          views_count: 0, // Initialize views
        })
        .returning()
    );

    // ✅ Invalidate blog list caches
    await cache.delPattern(CacheKeys.patterns.blogPostsLists());

    logger.info(`[Blog Service] Post created: ${post.title} (${post.id})`);
    return post;
  } catch (error) {
    logger.error('[Blog Service] Create post error:', error);
    throw error;
  }
};

// Update blog post
export const updateBlogPost = async (id, postData) => {
  try {
    // If changing to published and no published_at, set it now
    if (postData.status === 'published' && !postData.published_at) {
      postData.published_at = new Date();
    }

    // Recalculate read time if content changed
    if (postData.content) {
      postData.read_time_minutes = calculateReadTime(postData.content);
    }

    const [post] = await withTenantDb((tx) =>
      tx
        .update(blogPosts)
        .set({
          ...postData,
          updated_at: new Date(),
        })
        .where(eq(blogPosts.id, id))
        .returning()
    );

    if (!post) {
      return null;
    }

    // ✅ Invalidate caches
    await cache.delPattern(CacheKeys.patterns.blogPostsLists());
    await cache.del(CacheKeys.blogPost(post.slug));

    logger.info(`[Blog Service] Post updated: ${post.title} (${post.id})`);
    return post;
  } catch (error) {
    logger.error(`[Blog Service] Update post ${id} error:`, error);
    throw error;
  }
};

// Delete blog post
export const deleteBlogPost = async (id) => {
  try {
    const [post] = await withTenantDb((tx) =>
      tx.delete(blogPosts).where(eq(blogPosts.id, id)).returning()
    );

    if (!post) {
      return null;
    }

    // ✅ Invalidate caches
    await cache.delPattern(CacheKeys.patterns.blogPostsLists());
    await cache.del(CacheKeys.blogPost(post.slug));

    logger.info(`[Blog Service] Post deleted: ${post.title} (${post.id})`);
    return post;
  } catch (error) {
    logger.error(`[Blog Service] Delete post ${id} error:`, error);
    throw error;
  }
};

// ============================================
// BLOG CATEGORIES
// ============================================

// Get all categories
export const getAllCategories = async () => {
  try {
    // ✅ Cache categories (they rarely change)
    const cacheKey = CacheKeys.blogCategories();

    return await cache.wrap(cacheKey, 1800, async () => {
      const categories = await withTenantDb((tx) =>
        tx.select().from(blogCategories).orderBy(asc(blogCategories.name))
      );

      return categories;
    });
  } catch (error) {
    logger.error('[Blog Service] Get all categories error:', error);
    throw error;
  }
};

// Get category by ID
export const getCategoryById = async (id) => {
  try {
    const [category] = await withTenantDb((tx) =>
      tx.select().from(blogCategories).where(eq(blogCategories.id, id)).limit(1)
    );

    return category || null;
  } catch (error) {
    logger.error(`[Blog Service] Get category ${id} error:`, error);
    throw error;
  }
};

// Create category
export const createBlogCategory = async (categoryData) => {
  try {
    const slug = categoryData.slug || createSlug(categoryData.name);

    const [category] = await withTenantDb((tx) =>
      tx
        .insert(blogCategories)
        .values({
          ...categoryData,
          // After the spread: caller-supplied input must not be able to set
          // tenant_id and write into another operator's data.
          tenant_id: currentTenantId(),
          slug,
        })
        .returning()
    );

    // ✅ Invalidate categories cache
    await cache.del(CacheKeys.blogCategories());

    logger.info(`[Blog Service] Category created: ${category.name}`);
    return category;
  } catch (error) {
    logger.error('[Blog Service] Create category error:', error);
    throw error;
  }
};

// Update category
export const updateBlogCategory = async (id, categoryData) => {
  try {
    const [category] = await withTenantDb((tx) =>
      tx
        .update(blogCategories)
        .set({
          ...categoryData,
          updated_at: new Date(),
        })
        .where(eq(blogCategories.id, id))
        .returning()
    );

    if (!category) {
      return null;
    }

    // ✅ Invalidate categories cache
    await cache.del(CacheKeys.blogCategories());

    logger.info(`[Blog Service] Category updated: ${category.name}`);
    return category;
  } catch (error) {
    logger.error(`[Blog Service] Update category ${id} error:`, error);
    throw error;
  }
};

// Delete category
export const deleteBlogCategory = async (id) => {
  try {
    // Check if category has posts
    const [postsCount] = await withTenantDb((tx) =>
      tx
        .select({ count: sql`count(*)::int` })
        .from(blogPosts)
        .where(eq(blogPosts.category_id, id))
    );

    if (postsCount.count > 0) {
      throw new Error(
        `Cannot delete category with ${postsCount.count} posts. Reassign or delete posts first.`
      );
    }

    const [category] = await withTenantDb((tx) =>
      tx.delete(blogCategories).where(eq(blogCategories.id, id)).returning()
    );

    if (!category) {
      return null;
    }

    // ✅ Invalidate categories cache
    await cache.del(CacheKeys.blogCategories());

    logger.info(`[Blog Service] Category deleted: ${category.name}`);
    return category;
  } catch (error) {
    logger.error(`[Blog Service] Delete category ${id} error:`, error);
    throw error;
  }
};
