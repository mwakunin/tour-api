import { envFile } from '#config/loadEnv.js';
import ImageKit from '@imagekit/nodejs';
import logger from '#config/logger.js';

// The upload endpoint is reached over a link that is often slow and jittery, so
// every call needs a ceiling. The legacy `imagekit` v6 SDK built its axios
// request with no `timeout` at all (axios default 0 = wait forever), which is
// how single uploads were observed running for 245s while holding the request,
// the multer buffer and the socket open. v7 bounds each attempt and retries
// transient failures itself.
const REQUEST_TIMEOUT_MS = Number(process.env.IMAGEKIT_TIMEOUT_MS || 45_000);
const MAX_RETRIES = Number(process.env.IMAGEKIT_MAX_RETRIES || 2);

export const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;

// v7 throws from the constructor on a missing key (v6 deferred it to call
// time), so an absent variable takes the whole server down at import. Name the
// env file we actually read, because loading the wrong one is precisely how
// "Your account cannot be authenticated." happened.
if (!process.env.IMAGEKIT_PRIVATE_KEY) {
  logger.error(
    `[ImageKit] IMAGEKIT_PRIVATE_KEY is not set. Loaded env from "${envFile}" (NODE_ENV=${process.env.NODE_ENV}).`
  );
}

const imagekit = new ImageKit({
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  timeout: REQUEST_TIMEOUT_MS,
  maxRetries: MAX_RETRIES,
});

export default imagekit;
