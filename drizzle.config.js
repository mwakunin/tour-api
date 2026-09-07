import { config } from 'dotenv';

const env = process.env.NODE_ENV;

const getEnvFile = () => {
  if (env === 'test') return '.env.test';
  if (env === 'production') return '.env.production';
  return '.env';
};

config({ path: getEnvFile(), override: true });

export default {
  schema: './src/models/*.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
};
