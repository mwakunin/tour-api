# Tenancy: what is built, what is deliberately not

This repo separates two things that are easy to conflate:

1. **Tenancy infrastructure** — the parts that are brutal to retrofit later.
   Every table carries `tenant_id`, RLS policies isolate every tenant-scoped
   table, the app connects as a NOBYPASSRLS role, requests resolve an operator
   from their hostname, and operator identity (name, notification address,
   payment credentials) lives in tenant rows. **This is built.**
2. **The tenancy product** — the operator-facing surface for creating and
   managing operators. Signup, billing, a tenant switcher, a settings UI.
   **This is deliberately not built**, because none of it is expensive to add
   later and all of it is premature before there is a business reason.

Nothing user-facing says the word "tenant". Footloose runs as the seeded row,
`00000000-0000-0000-0000-000000000001`, and is the template every future
operator follows.

## Onboarding operator #2 today (by hand, ~15 minutes)

1. The operator signs up on the main host like any customer. Better Auth
   creates a global `user` row; they hold no membership anywhere yet.
2. Run `scripts/provision-tenant.js` with their name, slug and signup email.
   It atomically creates the tenant row and an `owner` membership for that
   user — an operator with no owner is a state the script refuses to leave
   behind.
3. Point `<slug>.<TENANT_HOST_SUFFIX>` at the deployment in DNS. From then on
   that host resolves to their tenant; `resolveTenant` 404s unknown or
   suspended hosts rather than falling back to the seeded operator.
4. They configure their own identity through the APIs that already exist:
   `admin_email` for where their notifications go, their M-Pesa/Pesapal
   credentials so customer money settles into their own shortcode, and their
   `tenants.name` — which is what their emails and invoice letterheads use
   (the branding is read from the tenant row, never hardcoded).
5. Staff: the memberships API (`/api/memberships`: grant, revoke, force
   logout) lets them manage their own team. Roles come from memberships at
   this operator, not from the global user.

Until step 3's DNS record exists, every host still answers as the seeded
operator — that is the single-operator deployment path, and it is what keeps
local dev and the live site working unchanged.

## What the product would add, and when it starts to matter

| Missing piece             | What it is                                                                                                                                                                                                                                                                                                          | Why it can wait                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Self-serve signup         | A form + endpoint wrapping exactly what `provision-tenant.js` does: create tenant, grant owner membership, validate slug.                                                                                                                                                                                           | A weekend of automation over an existing, tested operation. Matters when onboarding requests arrive without a human in the loop.          |
| Billing                   | Plans, trials, invoicing **for the platform itself** — who pays us for hosting them.                                                                                                                                                                                                                                | A different business problem from running tours. Zero trace of it belongs in the codebase until operators pay to be here.                 |
| Tenant switcher           | For a person working for two operators (the global `user` table explicitly supports this): switching active-operator context from the UI.                                                                                                                                                                           | Today "switching" means visiting the other operator's domain, which is fine at two operators and annoying at ten.                         |
| Operator settings surface | A UI for the things currently set by hand in SQL: `admin_email`, deposit terms (`tenants.deposit_percent_bps`, `balance_due_days_before_departure`), and eventually tagline/phone/address — which the email/invoice branding currently reads from env fallbacks precisely because no tenant columns exist for them. | The owner-plane `UPDATE` is honest while there is one operator; it stops scaling the day operator #2 asks to change something themselves. |

## The invariant to protect meanwhile

The infrastructure assumes **every tenant-scoped row names its tenant
explicitly and RLS enforces the boundary**. Two rules keep that true:

- New tenant-scoped tables are created WITHOUT a `tenant_id` default, and get
  added to the list in
  `src/__tests__/integration/tenant-defaults.test.js` (migration 0007's
  default was the one crutch that let an unattributed insert silently land in
  Footloose's books; 0011 removed it — do not bring it back).
- New tables get RLS with both `USING` and `WITH CHECK`, and any handler
  touching them goes through `withTenantDb` — never the owner connection,
  which bypasses RLS entirely.
