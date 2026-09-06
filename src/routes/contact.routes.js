// src/routes/contact.routes.js
import express from 'express';
import { sendContactMessage } from '../controllers/contact.controller.js';
import { publicSecurityMiddleware } from '../middleware/security.middleware.js';

const router = express.Router();

router.post('/', publicSecurityMiddleware, sendContactMessage);

export default router;
