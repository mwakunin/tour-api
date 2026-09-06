// src/config/loadEnv.js
//
// Single source of truth for which .env file this process reads.
//
// Every entry point (src/instrument.js, src/index.js) and every config module
// that needs credentials imports this instead of calling `dotenv/config`
// directly. That matters for two reasons:
//
//   1. `dotenv/config` always reads plain `.env`. Modules that used it were
//      getting development credentials while NODE_ENV=production — which is
//      how ImageKit ended up reporting "Your account cannot be authenticated."
//   2. Because dotenv does not overwrite variables that are already set, the
//      values a module saw depended on module import order. Redis and Pesapal
//      read production credentials only because src/server.js imports
//      database.js (which loads this file) before app.js. Swapping those two
//      lines would have silently pointed the payment service at sandbox keys.
//
// With one loader, running once, before anything else evaluates, neither
// failure mode is reachable.
import dotenv from 'dotenv';

const getEnvFile = () => {
  if (process.env.NODE_ENV === 'test') return '.env.test';
  if (process.env.NODE_ENV === 'production') return '.env.production';
  return '.env';
};

export const envFile = getEnvFile();

// `override: false` so variables injected by the deployment platform (Docker
// -e, Kubernetes secrets, CI) win over anything in a file. Rotating a
// credential in the deploy target must not be undone by a stale checked-in
// value. This is only safe because nothing loads a *different* env file before
// us; if you reintroduce a bare `import 'dotenv/config'` anywhere, that file's
// values will stick and this one will silently stop taking effect.
//
// Note `.env` and `.env.*` are in .dockerignore, so in a real deployment no
// file exists here at all and every value comes from the real environment.
//
// Tests are unaffected: src/__tests__/loadTestEnv.js applies .env.test with
// override: true before any module reaches this file.
dotenv.config({ path: envFile, override: false });
