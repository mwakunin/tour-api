// src/routes/blog.routes.js
import express from 'express';
import * as blogController from '#controllers/blog.controller.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import {
  authSecurityMiddleware,
  publicSecurityMiddleware,
} from '#middleware/security.middleware.js';

const router = express.Router();

// ============================================
// PUBLIC ROUTES (Caching handled in service layer)
// ============================================

// Get all published blog posts
router.get(
  '/posts',
  publicSecurityMiddleware,
  blogController.getPublishedPosts
);

// Get single published post by slug
router.get(
  '/posts/:slug',
  publicSecurityMiddleware,
  blogController.getPublishedPostBySlug
);

// Get all categories
router.get(
  '/categories',
  publicSecurityMiddleware,
  blogController.getCategories
);

// ============================================
// ADMIN ROUTES (Protected)
// ============================================

// Get all posts (including drafts)
router.get(
  '/admin/posts',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  blogController.getAllPosts
);

// Get single post by ID
router.get(
  '/admin/posts/id/:id',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  blogController.getPostById
);

// Get single post by slug (including drafts)
router.get(
  '/admin/posts/slug/:slug',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  blogController.getPostBySlug
);

// Create new post
router.post(
  '/admin/posts',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  blogController.createPost
);

// Update post
router.put(
  '/admin/posts/:id',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  blogController.updatePost
);

// Delete post
router.delete(
  '/admin/posts/:id',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  blogController.deletePost
);

// ============================================
// CATEGORY MANAGEMENT (Admin)
// ============================================

// Get category by ID
router.get(
  '/admin/categories/:id',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  blogController.getCategoryById
);

// Create category
router.post(
  '/admin/categories',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  blogController.createCategory
);

// Update category
router.put(
  '/admin/categories/:id',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  blogController.updateCategory
);

// Delete category
router.delete(
  '/admin/categories/:id',
  authSecurityMiddleware,
  requireAuth,
  requireAdmin,
  blogController.deleteCategory
);

export default router;
