import express from 'express';

const router = express.Router();

/**
 * POST /api/chat
 * Proxy chat requests to n8n workflow
 */
router.post('/', async (req, res) => {
  try {
    const response = await fetch(
      'https://n8n.footlooseadventures.com/webhook/safari-chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      }
    );

    if (!response.ok) {
      throw new Error(`n8n responded with status: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Chat proxy error:', error);
    res.status(500).json({
      error: 'Chat service unavailable',
      message: error.message,
    });
  }
});

export default router;
