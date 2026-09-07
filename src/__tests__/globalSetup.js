import 'dotenv/config';

export default async () => {
  console.log('🧪 Global Test Setup Starting...');

  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || 'test-session-secret-min-32-chars';

  console.log('📊 Environment:', process.env.NODE_ENV);

  const dbUrl = process.env.DATABASE_URL || '';

  if (!dbUrl) {
    throw new Error('❌ DATABASE_URL not set!');
  }

  const extractEndpoint = (url) =>
    url.split('@')[1]?.split('?')[0].split('/')[0] || '';

  const currentEndpoint = extractEndpoint(dbUrl);

  console.log(
    '🗄️  Current endpoint:',
    currentEndpoint.substring(0, 30) +
      (currentEndpoint.length > 30 ? '...' : '')
  );

  console.log('✅ Global setup complete\n');
};
