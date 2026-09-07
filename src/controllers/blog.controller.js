// src/controllers/blog.controller.js
import * as blogService from '#services/blog.service.js';
import {
  createBlogPostSchema,
  updateBlogPostSchema,
  createBlogCategorySchema,
  updateBlogCategorySchema,
  getBlogPostsQuerySchema,
} from '#validations/blog.validation.js';
import logger from '#config/logger.js';

// ============================================
// PUBLIC ROUTES
// ============================================

// Get all published posts
export const getPublishedPosts = async (req, res, next) => {
  try {
    // ✅ Validate query parameters
    const validatedQuery = getBlogPostsQuerySchema.parse({
      ...req.query,
      status: 'published', // Force published for public route
    });

    const result = await blogService.getAllBlogPosts(validatedQuery);

    // ✅ Handle cache wrapper
    const { posts, pagination } = result.data || result;

    res.json({
      success: true,
      data: posts,
      pagination,
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: error.issues,
      });
    }
    logger.error('[Blog Controller] Get published posts error:', error);
    next(error);
  }
};

// Get single published post by slug
export const getPublishedPostBySlug = async (req, res, next) => {
  try {
    const post = await blogService.getBlogPostBySlug(req.params.slug, true);

    if (!post || post.status !== 'published') {
      return res.status(404).json({
        success: false,
        error: 'Blog post not found',
      });
    }

    res.json({
      success: true,
      data: post,
    });
  } catch (error) {
    logger.error('[Blog Controller] Get published post error:', error);
    next(error);
  }
};

// Get all categories
export const getCategories = async (req, res, next) => {
  try {
    const result = await blogService.getAllCategories();

    // ✅ Handle cache wrapper — cache.wrap() returns { data, cached }, so
    // without this the response was { data: { data: [...], cached } } and
    // every client reading `data` as an array saw nothing.
    const categories = result?.data ?? result;

    res.json({
      success: true,
      data: categories,
    });
  } catch (error) {
    logger.error('[Blog Controller] Get categories error:', error);
    next(error);
  }
};

// ============================================
// ADMIN ROUTES
// ============================================

// Get all posts (including drafts)
export const getAllPosts = async (req, res, next) => {
  try {
    // ✅ Validate query parameters (allow all statuses for admin)
    const validatedQuery = getBlogPostsQuerySchema.parse({
      ...req.query,
      status: req.query.status || 'all',
    });

    const result = await blogService.getAllBlogPosts(validatedQuery);

    // res.json({
    //  success: true,
    // ...result,
    // Same unwrap as getPublishedPosts: cache.wrap returns { data, cached },
    // so reading result.posts straight off it yields undefined on a cache hit.
    const { posts, pagination } = result.data || result;

    res.json({
      success: true,
      data: posts,
      pagination,
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: error.issues,
      });
    }
    logger.error('[Blog Controller] Get all posts error:', error);
    next(error);
  }
};

// Get post by ID
export const getPostById = async (req, res, next) => {
  try {
    const post = await blogService.getBlogPostById(req.params.id);

    if (!post) {
      return res.status(404).json({
        success: false,
        error: 'Blog post not found',
      });
    }

    res.json({
      success: true,
      data: post,
    });
  } catch (error) {
    logger.error('[Blog Controller] Get post by ID error:', error);
    next(error);
  }
};

// Get post by slug (admin - includes drafts)
export const getPostBySlug = async (req, res, next) => {
  try {
    const post = await blogService.getBlogPostBySlug(req.params.slug, false);

    if (!post) {
      return res.status(404).json({
        success: false,
        error: 'Blog post not found',
      });
    }

    res.json({
      success: true,
      data: post,
    });
  } catch (error) {
    logger.error('[Blog Controller] Get post by slug error:', error);
    next(error);
  }
};

// Create post
export const createPost = async (req, res, next) => {
  try {
    // ✅ Validate request body
    const validatedData = createBlogPostSchema.parse(req.body);

    const post = await blogService.createBlogPost(
      validatedData,
      req.session.userId
    );

    res.status(201).json({
      success: true,
      data: post,
      message: 'Blog post created successfully',
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.issues,
      });
    }
    logger.error('[Blog Controller] Create post error:', error);
    next(error);
  }
};

// Update post
export const updatePost = async (req, res, next) => {
  try {
    // ✅ Validate request body
    const validatedData = updateBlogPostSchema.parse(req.body);

    const post = await blogService.updateBlogPost(req.params.id, validatedData);

    if (!post) {
      return res.status(404).json({
        success: false,
        error: 'Blog post not found',
      });
    }

    res.json({
      success: true,
      data: post,
      message: 'Blog post updated successfully',
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.issues,
      });
    }
    logger.error('[Blog Controller] Update post error:', error);
    next(error);
  }
};

// Delete post
export const deletePost = async (req, res, next) => {
  try {
    const post = await blogService.deleteBlogPost(req.params.id);

    if (!post) {
      return res.status(404).json({
        success: false,
        error: 'Blog post not found',
      });
    }

    res.json({
      success: true,
      message: 'Blog post deleted successfully',
    });
  } catch (error) {
    logger.error('[Blog Controller] Delete post error:', error);
    next(error);
  }
};

// ============================================
// CATEGORY MANAGEMENT
// ============================================

// Get category by ID
export const getCategoryById = async (req, res, next) => {
  try {
    const category = await blogService.getCategoryById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        error: 'Category not found',
      });
    }

    res.json({
      success: true,
      data: category,
    });
  } catch (error) {
    logger.error('[Blog Controller] Get category error:', error);
    next(error);
  }
};

// Create category
export const createCategory = async (req, res, next) => {
  try {
    // ✅ Validate request body
    const validatedData = createBlogCategorySchema.parse(req.body);

    const category = await blogService.createBlogCategory(validatedData);

    res.status(201).json({
      success: true,
      data: category,
      message: 'Category created successfully',
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.issues,
      });
    }
    logger.error('[Blog Controller] Create category error:', error);
    next(error);
  }
};

// Update category
export const updateCategory = async (req, res, next) => {
  try {
    // ✅ Validate request body
    const validatedData = updateBlogCategorySchema.parse(req.body);

    const category = await blogService.updateBlogCategory(
      req.params.id,
      validatedData
    );

    if (!category) {
      return res.status(404).json({
        success: false,
        error: 'Category not found',
      });
    }

    res.json({
      success: true,
      data: category,
      message: 'Category updated successfully',
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.issues,
      });
    }
    logger.error('[Blog Controller] Update category error:', error);
    next(error);
  }
};

// Delete category
export const deleteCategory = async (req, res, next) => {
  try {
    const category = await blogService.deleteBlogCategory(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        error: 'Category not found',
      });
    }

    res.json({
      success: true,
      message: 'Category deleted successfully',
    });
  } catch (error) {
    // ✅ Handle specific error from service
    if (error.message?.includes('Cannot delete category with')) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }
    logger.error('[Blog Controller] Delete category error:', error);
    next(error);
  }
};
