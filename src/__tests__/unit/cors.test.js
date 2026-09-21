import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// The module reads its configuration at import time and logs once, so each
// case has to load a fresh copy with the environment already set.
const loadCors = async (env) => {
  const saved = {
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    ALLOWED_ORIGIN_DOMAIN: process.env.ALLOWED_ORIGIN_DOMAIN,
    NODE_ENV: process.env.NODE_ENV,
  };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const url = `#config/cors.config.js?v=${Math.random()}`;
  const mod = await import(url);

  Object.assign(process.env, saved);
  return mod.corsOptions;
};

const allows = (corsOptions, origin) =>
  new Promise((resolve) => {
    corsOptions.origin(origin, (err) => resolve(!err));
  });

describe('CORS origin matching', () => {
  let corsOptions;

  beforeEach(async () => {
    corsOptions = await loadCors({
      ALLOWED_ORIGIN_DOMAIN: 'tourops.com',
      ALLOWED_ORIGINS: 'https://partner.example',
      NODE_ENV: 'production',
    });
  });

  afterEach(() => {
    delete process.env.ALLOWED_ORIGIN_DOMAIN;
  });

  it('admits the domain and its subdomains', async () => {
    expect(await allows(corsOptions, 'https://tourops.com')).toBe(true);
    expect(await allows(corsOptions, 'https://acme.tourops.com')).toBe(true);
    expect(await allows(corsOptions, 'https://zebra.tourops.com')).toBe(true);
  });

  it('is not fooled by a domain that merely ends with it', async () => {
    // The classic endsWith bug. `eviltourops.com` ends with `tourops.com`.
    expect(await allows(corsOptions, 'https://eviltourops.com')).toBe(false);
    expect(await allows(corsOptions, 'https://nottourops.com')).toBe(false);
  });

  it('is not fooled by the domain appearing after it', async () => {
    // Suffix confusion the other way round: the real domain as a prefix of
    // somebody else's.
    expect(await allows(corsOptions, 'https://tourops.com.attacker.net')).toBe(
      false
    );
  });

  it('is not fooled by the domain in a path or query', async () => {
    // Why this compares a parsed hostname rather than the raw string.
    expect(
      await allows(corsOptions, 'https://attacker.net/?x=tourops.com')
    ).toBe(false);
    expect(await allows(corsOptions, 'https://attacker.net/tourops.com')).toBe(
      false
    );
  });

  it('refuses http on the real domain', async () => {
    // An http origin under the operator's own domain means somebody is being
    // stripped, and the session cookie is Secure regardless.
    expect(await allows(corsOptions, 'http://acme.tourops.com')).toBe(false);
  });

  it('still honours the exact list alongside the domain', async () => {
    expect(await allows(corsOptions, 'https://partner.example')).toBe(true);
    expect(await allows(corsOptions, 'https://other.example')).toBe(false);
  });

  it('allows a request with no origin at all', async () => {
    // M-Pesa and Pesapal post callbacks server-to-server with no Origin.
    expect(await allows(corsOptions, undefined)).toBe(true);
  });

  it('falls back to nothing in production when unconfigured', async () => {
    const bare = await loadCors({
      ALLOWED_ORIGINS: undefined,
      ALLOWED_ORIGIN_DOMAIN: undefined,
      NODE_ENV: 'production',
    });

    // The production list used to be three hardcoded footlooseadventures
    // domains, which every other operator's deployment would have inherited.
    expect(await allows(bare, 'https://footlooseadventures.co.ke')).toBe(false);
    expect(await allows(bare, 'https://anything.com')).toBe(false);
  });
});
