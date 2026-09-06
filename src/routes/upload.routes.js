// src/routes/upload.routes.js
import express from 'express';
import { single, multiple } from '#middleware/upload.middleware.js';
import { requireAuth, requireAdmin } from '#middleware/auth.middleware.js';
import {
  uploadSingle,
  uploadMultiple,
  deleteFile,
  getFile,
  getOptimizedImage,
  getResponsiveImages,
  getFilesByFolderController,
  listFilesController,
} from '#controllers/upload.controller.js';

const router = express.Router();

// ✅ ADMIN ONLY - Upload routes
router.post('/single', requireAuth, requireAdmin, single, uploadSingle);
router.post('/multiple', requireAuth, requireAdmin, multiple, uploadMultiple);

// ✅ ADMIN ONLY - Delete
router.delete('/:id', requireAuth, requireAdmin, deleteFile);

// ✅ ADMIN ONLY - Media library listing (search/filter/paginate across folders)
router.get('/', requireAuth, requireAdmin, listFilesController);

// ✅ AUTHENTICATED USERS - View/optimize
router.get('/folder/:folder', requireAuth, getFilesByFolderController);
router.get('/:id/optimized', requireAuth, getOptimizedImage);
router.get('/:id/responsive', requireAuth, getResponsiveImages);
router.get('/:id', requireAuth, getFile);

export default router;
