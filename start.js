console.log('📦 Loading Sentry instrumentation...');

import('./src/instrument.js')
  .then(() => import('./src/index.js'))
  .catch((error) => {
    console.error('❌ Failed to start:', error);
    process.exit(1);
  });
