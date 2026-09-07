import multer from 'multer';

const storage = multer.memoryStorage();

// memoryStorage() buffers each upload in full, so (files × fileSize) is the
// worst-case RSS a single request can pin. Buffers live outside the V8 heap, so
// `--max-old-space-size=1024` in the Dockerfile does not bound them — the
// failure mode is an OOM kill at the container level, not a heap error.
//
// The two routes are therefore limited separately, so neither can pin much more
// than ~100MB:
//
//   /single   1 file  × 25MB = 25MB   — generous, fileFilter admits video
//   /multiple 10 files × 10MB = 100MB — was 10 × 25MB = 250MB
//
// Capping the batch route by per-file size rather than by file count keeps the
// admin media library's bulk upload working (its picker is uncapped and posts
// the whole selection). Real batches are images of a few MB at most; anything
// larger than 10MB — a video, say — goes through /single.
//
// If uploads are ever opened beyond admins, switch to diskStorage and stream to
// ImageKit via fs.createReadStream rather than raising these.
export const MAX_FILES = 10;
export const MAX_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_BATCH_FILE_SIZE = 10 * 1024 * 1024;

const fileFilter = (req, file, cb) => {
  // Accept images and videos
  if (
    file.mimetype.startsWith('image/') ||
    file.mimetype.startsWith('video/')
  ) {
    cb(null, true);
  } else {
    // Tagged so the error handler can answer 415 rather than the generic 500.
    const err = new Error(
      `Unsupported file type: ${file.mimetype}. Only images and videos are allowed.`
    );
    err.statusCode = 415;
    cb(err, false);
  }
};

// memoryStorage buffers everything in RAM, so the non-file parts are capped too
// rather than left unbounded.
const sharedLimits = { fields: 20, fieldSize: 100 * 1024 };

const uploadSingle = multer({
  storage,
  fileFilter,
  limits: { ...sharedLimits, fileSize: MAX_FILE_SIZE, files: 1 },
});

const uploadBatch = multer({
  storage,
  fileFilter,
  limits: { ...sharedLimits, fileSize: MAX_BATCH_FILE_SIZE, files: MAX_FILES },
});

export const single = uploadSingle.single('file');
export const multiple = uploadBatch.array('files', MAX_FILES);
