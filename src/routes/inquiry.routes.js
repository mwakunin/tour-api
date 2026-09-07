// src/routes/inquiry.routes.js
import express from 'express';
import { createInquiry } from '../controllers/inquiry.controller.js';
import { publicSecurityMiddleware } from '../middleware/security.middleware.js';

const router = express.Router();

router.post('/', publicSecurityMiddleware, createInquiry);

export default router;
