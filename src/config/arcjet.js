import arcjet, { shield, detectBot } from '@arcjet/node';

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: 'LIVE' }), // only global rule needed
  ],
});

export const ajWithBotDetection = aj.withRule(
  detectBot({
    mode: 'LIVE',
    allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:PREVIEW', 'CURL', 'POSTMAN'],
  })
);

export default aj;
