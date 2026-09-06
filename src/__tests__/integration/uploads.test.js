// src/__tests__/integration/uploads.test.js
import { jest } from '@jest/globals';

// The real SDK, used only to build URLs — buildSrc is pure string work with no
// network, so mocking it would hide exactly the kind of bug it once had
// (an absolute URL passed as `path` produced a double-https URL).
const { default: ImageKit } = await import('@imagekit/nodejs');
const realHelper = new ImageKit({ privateKey: 'private_test' }).helper;

const TEST_URL_ENDPOINT = 'https://ik.imagekit.io/footloose';

jest.unstable_mockModule('#config/imagekit.js', () => ({
  urlEndpoint: TEST_URL_ENDPOINT,
  default: {
    files: {
      upload: jest.fn(({ fileName, folder, tags }) =>
        Promise.resolve({
          fileId: `mock-fileid-${fileName}-${Math.random().toString(36).slice(2, 10)}`,
          name: fileName,
          url: `${TEST_URL_ENDPOINT}/${folder}/${fileName}`,
          thumbnailUrl: `${TEST_URL_ENDPOINT}/${folder}/thumb-${fileName}`,
          size: 12345,
          height: 800,
          width: 600,
          tags,
          metadata: { hasTransparency: false, exif: { image: {} } },
        })
      ),
      delete: jest.fn(() => Promise.resolve()),
    },
    helper: {
      buildSrc: jest.fn((opts) => realHelper.buildSrc(opts)),
    },
  },
}));

// Everything that transitively imports #config/imagekit.js must be
// dynamically imported AFTER the mock is registered above.
const { default: request } = await import('supertest');
const { eq } = await import('drizzle-orm');
const { default: app } = await import('../../app.js');
const { db, initDatabase } = await import('#config/database.js');
const redis = (await import('#config/redis.js')).default;
const { files } = await import('#models/file.model.js');
const { MAX_FILE_SIZE, MAX_BATCH_FILE_SIZE } =
  await import('#middleware/upload.middleware.js');
const {
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
  deleteTestUser,
  cleanupTestSession,
} = await import('../helpers/auth.helper.js');

describe('Upload API Integration Tests', () => {
  let agent;
  let adminAgent;
  let testUser;
  let testAdmin;
  let sessionId;
  let adminSessionId;
  let uploadedFileIds = [];

  // Mock file buffers
  const mockImageBuffer = Buffer.from('fake-image-data');

  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(async () => {
    uploadedFileIds = [];

    // Create users
    const userAuth = await createAuthenticatedAgent(app, redis);
    agent = userAuth.agent;
    testUser = userAuth.user;
    sessionId = userAuth.sessionId;

    const adminAuth = await createAuthenticatedAdminAgent(app);
    adminAgent = adminAuth.agent;
    testAdmin = adminAuth.user;
    adminSessionId = adminAuth.sessionId;
  });

  afterEach(async () => {
    // Clean up uploaded files
    for (const fileId of uploadedFileIds) {
      try {
        await db.delete(files).where(eq(files.id, fileId));
      } catch {
        // File might not exist
      }
    }
    uploadedFileIds = [];

    // Clean up users and sessions
    await deleteTestUser(testUser.id);
    await deleteTestUser(testAdmin.id);
    await cleanupTestSession(redis, sessionId);
    await cleanupTestSession(redis, adminSessionId);
  });

  afterAll(async () => {
    await redis.quit();
  });

  // ========================================
  // TEST 1: Upload Single File (Admin Only)
  // ========================================
  describe('POST /api/uploads/single - Upload Single File', () => {
    it('should upload single image with valid admin credentials', async () => {
      const response = await adminAgent
        .post('/api/uploads/single')
        .field('folder', 'tours')
        .field('tags', 'safari,wildlife')
        .attach('file', mockImageBuffer, 'test-image.jpg')
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data).toHaveProperty('url');
      expect(response.body.data.folder).toBe('tours');

      // Verify tags were parsed correctly
      expect(response.body.data.tags).toContain('safari');
      expect(response.body.data.tags).toContain('wildlife');

      // Dimensions come from ImageKit's upload response and belong in the
      // real columns — they used to be hardcoded null by a stub helper.
      const [stored] = await db
        .select()
        .from(files)
        .where(eq(files.id, response.body.data.id));

      expect(stored.width).toBe(600);
      expect(stored.height).toBe(800);

      uploadedFileIds.push(response.body.data.id);
    });

    it('should upload to default folder when not specified', async () => {
      const response = await adminAgent
        .post('/api/uploads/single')
        .attach('file', mockImageBuffer, 'test-image.jpg');
      //.expect(201);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.folder).toBe('general');

      uploadedFileIds.push(response.body.data.id);
    });

    it('should fail without authentication', async () => {
      await request(app)
        .post('/api/uploads/single')
        .attach('file', mockImageBuffer, 'test-image.jpg')
        .expect(401);
    });

    it('should fail with non-admin user', async () => {
      await agent
        .post('/api/uploads/single')
        .attach('file', mockImageBuffer, 'test-image.jpg')
        .expect(403);
    });

    it('should fail without file', async () => {
      const response = await adminAgent
        .post('/api/uploads/single')
        .field('folder', 'tours')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('No file provided');
    });

    it('should fail with invalid folder name', async () => {
      // ✅ API rejects invalid folder names (may return 400 or 500 depending on validation layer)
      const response = await adminAgent
        .post('/api/uploads/single')
        .field('folder', 'Invalid Folder!')
        .attach('file', mockImageBuffer, 'test-image.jpg');

      // Accept either 400 (validation) or 500 (ImageKit rejection)
      expect([400, 500]).toContain(response.status);
      expect(response.body.success).toBe(false);
    });

    it('should reject an oversized file with 413, not 500', async () => {
      const oversized = Buffer.alloc(MAX_FILE_SIZE + 1024, 0);

      const response = await adminAgent
        .post('/api/uploads/single')
        .field('folder', 'tours')
        .attach('file', oversized, 'huge.jpg')
        .expect(413);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/too large/i);
    });

    it('should reject an unsupported file type with 415, not 500', async () => {
      const response = await adminAgent
        .post('/api/uploads/single')
        .field('folder', 'tours')
        .attach('file', Buffer.from('%PDF-1.4 fake'), {
          filename: 'doc.pdf',
          contentType: 'application/pdf',
        })
        .expect(415);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/unsupported file type/i);
    });
  });

  // ========================================
  // TEST 2: Upload Multiple Files (Admin Only)
  // ========================================
  describe('POST /api/uploads/multiple - Upload Multiple Files', () => {
    it('should upload multiple files with valid admin credentials', async () => {
      const response = await adminAgent
        .post('/api/uploads/multiple')
        .field('folder', 'destinations')
        .field('tags', 'landscape,scenery')
        .attach('files', mockImageBuffer, 'image1.jpg')
        .attach('files', mockImageBuffer, 'image2.jpg')
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(2);

      response.body.data.forEach((file) => {
        expect(file).toHaveProperty('id');
        expect(file).toHaveProperty('url');
        expect(file.folder).toBe('destinations');
        uploadedFileIds.push(file.id);
      });
    });

    it('should fail without authentication', async () => {
      await request(app)
        .post('/api/uploads/multiple')
        .attach('files', mockImageBuffer, 'image1.jpg')
        .expect(401);
    });

    it('should fail with non-admin user', async () => {
      await agent
        .post('/api/uploads/multiple')
        .attach('files', mockImageBuffer, 'image1.jpg')
        .expect(403);
    });

    it('should fail without files', async () => {
      const response = await adminAgent
        .post('/api/uploads/multiple')
        .field('folder', 'tours')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('No files provided');
    });

    it('applies the tighter per-file limit to batch uploads', async () => {
      // The batch route caps each file at MAX_BATCH_FILE_SIZE so ten of them
      // can't pin ~250MB of memoryStorage at once. A file this size is fine on
      // /single but must be rejected here.
      const betweenLimits = Buffer.alloc(MAX_BATCH_FILE_SIZE + 1024, 0);

      const response = await adminAgent
        .post('/api/uploads/multiple')
        .field('folder', 'tours')
        .attach('files', betweenLimits, 'big.jpg')
        .expect(413);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/per file in a batch upload/i);
    });
  });

  // ========================================
  // TEST 3: Get File by ID (Authenticated Users)
  // ========================================
  describe('GET /api/uploads/:id - Get File', () => {
    let testFileId;

    beforeEach(async () => {
      const [file] = await db
        .insert(files)
        .values({
          fileId: `test-file-${Date.now()}`,
          fileName: 'test.jpg',
          originalName: 'original-test.jpg',
          url: 'https://ik.imagekit.io/test/test.jpg',
          thumbnailUrl: 'https://ik.imagekit.io/test/thumb.jpg',
          folder: 'general',
          fileType: 'image',
          mimeType: 'image/jpeg',
          size: 102400,
          tags: ['test'],
          metadata: {},
          uploadedBy: testAdmin.id,
        })
        .returning();

      testFileId = file.id;
      uploadedFileIds.push(testFileId);
    });

    it('should get file by ID for authenticated user', async () => {
      const response = await agent
        .get(`/api/uploads/${testFileId}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('id', testFileId);
      expect(response.body.data.folder).toBe('general');
    });

    it('should fail without authentication', async () => {
      await request(app).get(`/api/uploads/${testFileId}`).expect(401);
    });

    it('should return 404 for non-existent file', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const response = await agent.get(`/api/uploads/${fakeId}`).expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('File not found');
    });
  });

  // ========================================
  // TEST 4: Get Files by Folder (Authenticated Users)
  // ========================================
  describe('GET /api/uploads/folder/:folder - Get Files by Folder', () => {
    beforeEach(async () => {
      const fileData = [1, 2, 3].map((i) => ({
        fileId: `test-tour-file-${Date.now()}-${i}`,
        fileName: `tour-${i}.jpg`,
        originalName: `original-tour-${i}.jpg`,
        url: `https://ik.imagekit.io/test/tour-${i}.jpg`,
        folder: 'tours',
        fileType: 'image',
        mimeType: 'image/jpeg',
        size: 102400,
        tags: ['tour'],
        metadata: {},
        uploadedBy: testAdmin.id,
      }));

      const inserted = await db.insert(files).values(fileData).returning();
      uploadedFileIds.push(...inserted.map((f) => f.id));
    });

    it('should get all files in a folder for authenticated user', async () => {
      const response = await agent.get('/api/uploads/folder/tours').expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThanOrEqual(3);
      expect(response.body.count).toBeGreaterThanOrEqual(3);

      response.body.data.forEach((file) => {
        expect(file.folder).toBe('tours');
      });
    });

    it('should fail without authentication', async () => {
      await request(app).get('/api/uploads/folder/tours').expect(401);
    });

    it('should return empty array for non-existent folder', async () => {
      const response = await agent
        .get('/api/uploads/folder/non-existent-folder-xyz')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual([]);
      expect(response.body.count).toBe(0);
    });
  });

  // ========================================
  // TEST 5: Get Optimized Image (Authenticated Users)
  // ========================================
  describe('GET /api/uploads/:id/optimized - Get Optimized Image', () => {
    let testImageId;

    beforeEach(async () => {
      const [file] = await db
        .insert(files)
        .values({
          fileId: `test-image-${Date.now()}`,
          fileName: 'test-image.jpg',
          originalName: 'original-image.jpg',
          url: 'https://ik.imagekit.io/test/image.jpg',
          folder: 'general',
          fileType: 'image',
          mimeType: 'image/jpeg',
          size: 204800,
          tags: ['test'],
          metadata: {},
          uploadedBy: testAdmin.id,
        })
        .returning();

      testImageId = file.id;
      uploadedFileIds.push(testImageId);
    });

    it('should get optimized image URL with default parameters', async () => {
      const response = await agent
        .get(`/api/uploads/${testImageId}/optimized`)
        .expect(200);

      expect(response.body.success).toBe(true);

      const { url } = response.body.data;
      // Regression guard: passing the stored absolute URL as `path` rather than
      // `src` used to splice the endpoint in front of it, yielding
      // `https://ik.imagekit.io/<id>/tr:.../https:/ik.imagekit.io/<id>/...`.
      expect(url.match(/https:\/\//g)).toHaveLength(1);
      expect(url).toContain('https://ik.imagekit.io/test/image.jpg');
      expect(url).toContain('w-800');
      expect(url).toContain('h-600');
      expect(url).toContain('q-80');
    });

    it('should get optimized image with custom parameters', async () => {
      const response = await agent
        .get(`/api/uploads/${testImageId}/optimized`)
        .query({ width: 500, height: 300, quality: 90, format: 'webp' })
        .expect(200);

      expect(response.body.success).toBe(true);

      const { url } = response.body.data;
      expect(url.match(/https:\/\//g)).toHaveLength(1);
      expect(url).toContain('w-500');
      expect(url).toContain('h-300');
      expect(url).toContain('q-90');
      expect(url).toContain('f-webp');
    });

    it('should fail for non-image files', async () => {
      const [videoFile] = await db
        .insert(files)
        .values({
          fileId: `test-video-${Date.now()}`,
          fileName: 'test-video.mp4',
          originalName: 'original-video.mp4',
          url: 'https://ik.imagekit.io/test/video.mp4',
          folder: 'general',
          fileType: 'video',
          mimeType: 'video/mp4',
          size: 1024000,
          tags: ['test'],
          metadata: {},
          uploadedBy: testAdmin.id,
        })
        .returning();

      uploadedFileIds.push(videoFile.id);

      const response = await agent
        .get(`/api/uploads/${videoFile.id}/optimized`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('File is not an image');
    });

    it('should fail without authentication', async () => {
      await request(app)
        .get(`/api/uploads/${testImageId}/optimized`)
        .expect(401);
    });
  });

  // ========================================
  // TEST 6: Get Responsive Images (Authenticated Users)
  // ========================================
  describe('GET /api/uploads/:id/responsive - Get Responsive Images', () => {
    let testImageId;

    beforeEach(async () => {
      const [file] = await db
        .insert(files)
        .values({
          fileId: `responsive-${Date.now()}`,
          fileName: 'responsive.jpg',
          originalName: 'original-responsive.jpg',
          url: 'https://ik.imagekit.io/test/responsive.jpg',
          folder: 'general',
          fileType: 'image',
          mimeType: 'image/jpeg',
          size: 307200,
          tags: ['test'],
          metadata: {},
          uploadedBy: testAdmin.id,
        })
        .returning();

      testImageId = file.id;
      uploadedFileIds.push(testImageId);
    });

    it('should get responsive image URLs', async () => {
      const response = await agent
        .get(`/api/uploads/${testImageId}/responsive`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('thumbnail');
      expect(response.body.data).toHaveProperty('small');
      expect(response.body.data).toHaveProperty('medium');
      expect(response.body.data).toHaveProperty('large');
      expect(response.body.data).toHaveProperty('original');

      // Every variant must be a single, well-formed URL — not the endpoint
      // spliced in front of an already-absolute one.
      Object.values(response.body.data).forEach((url) => {
        expect(typeof url).toBe('string');
        expect(url.match(/https:\/\//g)).toHaveLength(1);
      });

      expect(response.body.data.thumbnail).toContain('w-150');
      expect(response.body.data.large).toContain('w-1200');
      // `original` is the stored URL, untransformed.
      expect(response.body.data.original).toBe(
        'https://ik.imagekit.io/test/responsive.jpg'
      );
    });

    it('should fail without authentication', async () => {
      await request(app)
        .get(`/api/uploads/${testImageId}/responsive`)
        .expect(401);
    });
  });

  // ========================================
  // TEST 7: Delete File (Admin Only)
  // ========================================
  describe('DELETE /api/uploads/:id - Delete File', () => {
    let testFileId;

    beforeEach(async () => {
      const [file] = await db
        .insert(files)
        .values({
          fileId: `delete-me-${Date.now()}`,
          fileName: 'delete-me.jpg',
          originalName: 'original-delete.jpg',
          url: 'https://ik.imagekit.io/test/delete.jpg',
          folder: 'general',
          fileType: 'image',
          mimeType: 'image/jpeg',
          size: 102400,
          tags: ['test'],
          metadata: {},
          uploadedBy: testAdmin.id,
        })
        .returning();

      testFileId = file.id;
      uploadedFileIds.push(testFileId);
    });

    it('should delete file with valid admin credentials', async () => {
      const response = await adminAgent
        .delete(`/api/uploads/${testFileId}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('File deleted successfully');

      // Verify file was deleted
      const [deletedFile] = await db
        .select()
        .from(files)
        .where(eq(files.id, testFileId));

      expect(deletedFile).toBeUndefined();

      // Remove from cleanup list since it's deleted
      uploadedFileIds = uploadedFileIds.filter((id) => id !== testFileId);
    });

    it('should fail without authentication', async () => {
      await request(app).delete(`/api/uploads/${testFileId}`).expect(401);
    });

    it('should fail with non-admin user', async () => {
      await agent.delete(`/api/uploads/${testFileId}`).expect(403);
    });

    it('should return 404 for non-existent file', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const response = await adminAgent
        .delete(`/api/uploads/${fakeId}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('File not found');
    });

    it('should handle invalid UUID', async () => {
      await adminAgent.delete('/api/uploads/invalid-id').expect(400);
    });
  });
});
