# Architecture

## Overview

Polling Center is a static HTML/CSS/JS frontend (`index.html` plus
native ES modules under `js/` and stylesheets under `css/`, no build
step) talking directly to Supabase (Postgres + Auth + PostgREST)
over the Supabase JS client, using only the public anon/publishable key.
There is no separate backend server — every rule that matters (who can
read what, who can write what, how anonymity is preserved) is enforced
inside Postgres itself, via Row Level Security and `SECURITY DEFINER` RPC
functions, not trusted to the frontend.

Supabase project ref: `srbiynpchtwtpzcyrhgr`. See `supabase/migrations/`
for the full, applied migration history.

## Multi-tenancy model

- `organizations` — one row per tenant (TCABC, TCRDF, etc.). Publicly
  readable (so a public poll page can show the org's name); writable
  only through admin RPCs.
- `platform_owners` — a small set of users with cross-org admin rights
  (used for initial bootstrap of the platform).
- `org_admins` — join table: which users administer which organization.
  An admin sees/administers only their own org(s) unless they're also a
  platform owner.
- Every poll, question, and option belongs to exactly one organization
  (`polls.org_id`), and every admin-facing RLS policy and RPC checks
  `is_org_admin(auth.uid(), org_id)` before allowing a read or write.

## Data model

| Table | Purpose |
|---|---|
| `organizations` | Tenants |
| `platform_owners` | Cross-org admins |
| `org_admins` | Per-org admin membership |
| `polls` | One row per poll: type, access mode, anonymity flag, timezone, open/close times, results-visibility rule, status (draft/scheduled/open/closed/archived) |
| `questions` | Ordered questions within a poll |
| `options` | Ordered answer options / time slots within a question |
| `identified_responses` / `identified_answers` | Responses from a respondent whose name/email was collected (access mode "identified", or "device") |
| `voter_eligibility` | Per-election, per-voter hashed tokens (`token_hash`, never the raw token) — used to gate anonymous ballots and elections |
| `anonymous_ballots` / `anonymous_ballot_answers` | Cast ballots for anonymous/secret-ballot/election polls |
| `audit_log` | Admin-action audit trail (org-scoped, admin-readable only) |

Row Level Security is enabled on every one of these tables. Current
policy shape (see `supabase/migrations/0002_rls_and_functions.sql` and
later hardening migrations for the exact definitions):

- `organizations`: public `SELECT`; admin-only write.
- `polls` / `questions` / `options`: admin-only `SELECT` and write
  (`is_org_admin` gated) — **anonymous/public poll reading goes through
  RPCs** (`get_public_poll_detail`, `list_public_polls`), not direct
  table access, so a respondent's client never gets a raw row that could
  leak more than the poll's public-facing shape.
- `identified_responses` / `identified_answers` / `voter_eligibility`:
  admin-only `SELECT` (writes go through RPCs only).
- `org_admins`: a user can read their own membership rows or their org's
  membership rows; only an existing admin can write new ones.
- `audit_log`: admin-only `SELECT`.

## The RPC surface — the only write path

Nothing writes poll structure, votes, or admin state directly against a
table from the client. Every mutation goes through a `SECURITY DEFINER`
Postgres function that validates authorization and business rules inside
one transaction:

**Admin / structure**
- `save_poll_draft` — the *only* way poll/question/option rows are
  created or updated. Validates org-admin authorization, title,
  question/option shape per question type, and (as of migration
  `0014_save_poll_draft_boolean_null_guards.sql`) explicitly rejects a
  `null` where a boolean column is `NOT NULL`, rather than silently
  defaulting one — see that migration and `CLAUDE.md` for why.
- `publish_poll`, `close_poll`, `reopen_poll`, `archive_poll`,
  `duplicate_poll`, `set_final_option`, `release_results` — lifecycle
  transitions, all org-admin gated.
- `create_organization`, `add_org_admin`, `update_org_timezone`,
  `bootstrap_platform_owner` — org/admin management.
- `generate_election_tokens` — creates per-voter hashed tokens for an
  election (`voter_eligibility`); returns the raw token exactly once, to
  the admin, for distribution — it is never stored in plaintext.

**Respondent-facing (public / anon-callable where appropriate)**
- `get_public_poll_detail`, `list_public_polls` — read-only, shapes a
  poll for a respondent without exposing admin-only columns.
- `submit_identified_response` — for access modes that collect a
  name/email or a per-device dedup key.
- `cast_anonymous_ballot` — for anonymous/secret-ballot/election polls;
  takes a voter token, not an identity.
- `get_poll_results` — returns results only when the poll's configured
  `results_visibility` rule currently allows it for the caller.
- `get_poll_admin_monitor` — admin-only live monitor of response
  progress.

## How anonymity and election secrecy are enforced

This is the part that must never be weakened to fix a frontend bug (see
`CLAUDE.md`):

- An anonymous/secret-ballot/election poll's ballots live in
  `anonymous_ballots` / `anonymous_ballot_answers`, which carry **no
  respondent-identifying column at all** — no user id, no email, no
  device id, no IP.
- Voter eligibility for an election is tracked separately, in
  `voter_eligibility`, keyed by a **hash** of the token (`token_hash`),
  never the raw token. `cast_anonymous_ballot` looks up the hash, checks
  it hasn't been used, marks it used, and inserts the ballot — but there
  is no foreign key or join path from a `voter_eligibility` row to the
  `anonymous_ballots` row that was cast with it. Marking a token "used"
  and recording an answer are two separate, structurally unlinked writes
  by design.
- `cast_anonymous_ballot` and `generate_election_tokens` are
  `SECURITY DEFINER` with an explicit, closed `search_path`
  (`public, extensions, pg_temp` — see
  `supabase/migrations/0013_fix_pgcrypto_search_path.sql`), so they
  always resolve pgcrypto's `digest()`/`gen_random_bytes()` from a fixed
  location rather than whatever schema happens to be on the caller's
  search path.
- `get_poll_results` checks the poll's `results_visibility` setting
  (hidden / after-you-respond / while-open / after-close / manual) on
  every call — results are computed and returned only when that rule
  currently permits it, never cached or exposed ahead of it.

## Frontend structure

Vanilla JS, no framework, no build step. `index.html` is only the page
shell (header, `<main id="app">`, footer); it loads the Supabase JS UMD
client from a CDN, the stylesheets under `css/`, and `js/app.js` as a
native ES module. Layout follows `docs/phase1-implementation-map.md` §1:

- `js/app.js` — bootstrap: auth listener, header nav, the main
  `render()` route table, and `init()`.
- `js/router.js` — the hash router (`#/`, `#/poll/:id`, `#/admin`,
  `#/admin/new`, `#/admin/edit/:id`, `#/admin/poll/:id`), `navigate()`,
  and the `render()` hook views call.
- `js/supabase-client.js` — `sb`, the single Supabase client, initialized
  once with the project URL and anon key (both safe to be public).
- `js/state.js` — `state`, the app's in-memory state (session, current
  org, route), plus admin-context and org helpers derived from it.
- `js/admin/` — `auth.js` (sign-in / bootstrap), `dashboard.js`,
  `org-settings.js` (org default timezone), `poll-manage.js` (monitor,
  lifecycle, voter codes, CSV), `poll-builder.js` +
  `poll-builder-questions.js` (poll builder), and `draft-recovery.js`
  (the local draft-recovery/autosave store — see `docs/QA.md`).
- `js/public/` — `poll-list.js`, `poll-response.js` (poll detail /
  respond), `results-view.js` (results, shared with admin).
- `js/shared/` — `helpers.js`, `timezone.js`, `question-types.js`
  (respondent question rendering, shared by the builder preview),
  `export-csv.js`.
- `css/` — `tokens.css`, `base.css`, `components.css`, `admin.css`,
  `public.css`, loaded in that order.
- All timezone-sensitive rendering converts between the poll's configured
  timezone and UTC at the render/read boundary — `draft.open_at`,
  `draft.close_at`, and every option's `slot_start`/`slot_end` are always
  real UTC ISO instants in memory; only `<input>` display values are
  ever in wall-clock/local form.
