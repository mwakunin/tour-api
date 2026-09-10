// Creates an operator and gives it its first administrator.
//
//   OWNER_EMAIL=jane@acme.test pnpm run tenant:provision -- \
//     --name "Acme Safaris" --slug acme --prefix AC
//
// WHY THIS IS A SCRIPT AND NOT AN ENDPOINT
//
// Migration 0008 grants the runtime role SELECT on `tenants` and nothing else,
// deliberately: creating and suspending operators is an owner-plane act, not
// something a request handler may do. An endpoint would mean granting INSERT to
// tourops_app, which is the boundary that decision drew. So this connects as
// the owner (DATABASE_URL), like setup-app-role.js.
//
// It also solves the bootstrap that nothing else can. A new tenant has no
// members, and /api/memberships is admin-only -- so there is nobody who can
// grant the first membership, and no way in. That is the chicken-and-egg this
// exists to break, and the reason it grants `owner` rather than `admin`:
// the first one in should be the one role that cannot be revoked by an
// administrator who arrives later.
//
// The user must already exist. Creating a login here would mean minting an
// account against an email nobody has verified, and better-auth -- which owns
// password hashing and verification -- is not in this process. Have them sign
// up first, then run this.

import '../src/config/loadEnv.js';
import postgres from 'postgres';

const args = process.argv.slice(2);

const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

const name = flag('name');
const slug = flag('slug');
const prefix = flag('prefix');
const email = process.env.OWNER_EMAIL;

const usage = `Usage: OWNER_EMAIL=someone@example.com pnpm run tenant:provision -- \\
         --name "Acme Safaris" --slug acme --prefix AC`;

if (!name || !slug || !prefix || !email) {
  console.error(`[provision] name, slug, prefix and OWNER_EMAIL are all required.
${usage}`);
  process.exit(1);
}

// The same shape tenants_slug_dns_label enforces (migration 0027). Checked
// here too so the failure names the rule rather than surfacing a constraint.
if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
  console.error(
    `[provision] "${slug}" is not a usable subdomain label.\n` +
      '            Lowercase letters, digits and internal hyphens only.'
  );
  process.exit(1);
}

// Not enforced by the database -- RESERVED_LABELS lives in the middleware,
// which this script does not run through. Checked here because a tenant that
// resolves to nothing is worse than one that was never created: it exists,
// bills, and cannot be reached.
const RESERVED = ['api', 'www', 'app', 'admin', 'staging', 'dashboard'];
if (RESERVED.includes(slug)) {
  console.error(
    `[provision] "${slug}" is reserved for the deployment itself, so requests ` +
      'to it\n            would never resolve to this operator.'
  );
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  const [owner] = await sql`
    SELECT id, name FROM "user" WHERE lower(email) = lower(${email}) LIMIT 1
  `;

  if (!owner) {
    console.error(
      `[provision] No account for ${email}.\n` +
        '            They must sign up first -- this script does not create ' +
        'logins,\n            because better-auth owns password hashing and ' +
        'verification.'
    );
    process.exit(1);
  }

  // One transaction: an operator with no owner is the state this exists to
  // prevent, so it must not be a state the script can leave behind.
  const [tenant] = await sql.begin(async (tx) => {
    const [created] = await tx`
      INSERT INTO tenants (name, slug, booking_ref_prefix)
      VALUES (${name}, ${slug}, ${prefix})
      RETURNING id, name, slug
    `;

    await tx`
      INSERT INTO memberships (tenant_id, user_id, role)
      VALUES (${created.id}, ${owner.id}, 'owner')
    `;

    return [created];
  });

  console.log(`[provision] ${tenant.name} created.`);
  console.log(`[provision]   id    ${tenant.id}`);
  console.log(`[provision]   slug  ${tenant.slug}`);
  console.log(`[provision]   owner ${owner.name} <${email}>`);
  console.log(
    '[provision] Reachable once TENANT_HOST_SUFFIX is set and ' +
      `${tenant.slug}.<suffix> resolves. Until then every host still answers ` +
      'as the seeded operator.'
  );
} catch (error) {
  if (error.code === '23505') {
    console.error(
      `[provision] An operator already uses the slug "${slug}".\n` +
        '            Slugs are unique because they are hostnames.'
    );
    process.exit(1);
  }
  throw error;
} finally {
  await sql.end();
}
