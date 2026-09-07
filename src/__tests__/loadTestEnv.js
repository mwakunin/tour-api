import dotenv from 'dotenv';

dotenv.config({ path: '.env.test', override: true });
process.env.NODE_ENV = 'test';
