# CLAUDE.md — standing rules for Polling Center

This file is read by Claude Code (and should be read by any human
contributor) at the start of every session working in this repository.
These rules are not suggestions — they encode decisions Jana has already
made and constraints that protect real organizations' data. When a rule
here conflicts with what seems locally convenient, the rule wins; ask
before overriding it.

## Hosting

- The frontend is a single static `index.html` file. It is hosted on
  **Cloudflare Pages** (or equivalent static Cloudflare hosting) at
  **`https://polls.wwjanado.com`**. See `docs/deployment.md`.
- **Do not use Netlify for future Polling Center deployments.** This
  project previously deployed to Netlify; that is being replaced by
  Cloudflare Pages going forward. Don't reintroduce a Netlify config,
  Netlify-specific build settings, or Netlify deploy instructions.
- Do not add a build step, bundler, or framework dependency unless Jana
  explicitly asks for one. The single-file-static-hosting shape is
  deliberate.

## Backend / Supabase

- Supabase is the **existing** backend for this project (project ref
  `srbiynpchtwtpzcyrhgr`). **Do not create another Supabase project** for
  Polling Center — every change is a migration against this one project,
  applied through the Supabase MCP tools (`apply_migration`) or the
  Supabase CLI, and saved as a numbered file under
  `supabase/migrations/`.
- **Never expose service-role credentials.** The frontend embeds only the
  anon/publishable key (by design — it's meant to be public and is
  protected by RLS). The service-role key must never appear in
  `index.html`, in this repository, in a commit, in a log, or in any
  client-side code, ever.
- **Never weaken RLS, `NOT NULL` constraints, or election-anonymity
  protections to work around a frontend bug.** If the frontend sends bad
  data (a `null` where a boolean is required, an unauthorized request,
  etc.), fix the frontend at the source. A database constraint or RLS
  policy existing rule is not the thing to relax — see migration
  `0014_save_poll_draft_boolean_null_guards.sql` for the pattern this
  project follows instead: the database raises a clear, specific error
  and fails loudly rather than silently coalescing/defaulting around bad
  input.
- **Poll structure writes must continue through the approved server-side
  RPC/transaction path** — `save_poll_draft` is the only way poll/
  question/option rows get created or updated. There is no direct
  `insert`/`update`/`delete` against `polls`/`questions`/`options` from
  the client; that RPC validates admin authorization, organization scope,
  and every structural integrity rule in one transaction. Do not add a
  code path that bypasses it.
- **Anonymous ballots must remain structurally unlinkable** to voters,
  voter tokens, emails, devices, or IP addresses. `anonymous_ballots` and
  `anonymous_ballot_answers` carry no respondent-identifying column of
  any kind — voter-eligibility tokens are checked and marked used in a
  separate table (`voter_eligibility`) with no foreign key back to the
  ballot that was cast with them. Do not add one. Do not log a voter's
  token, IP, or device alongside a ballot anywhere (including
  `audit_log`).
- **Election results remain hidden until allowed by the configured
  rules** (`results_visibility` on the poll: hidden / after-you-respond /
  while-open / after-close / manual-release). Don't add a path that
  exposes results to a respondent or unauthenticated caller ahead of what
  that setting allows.

## Scope discipline

- **Do not add paid infrastructure without Jana's approval** — no new
  paid tiers, add-ons, or third-party services charged to any of her
  accounts without asking first.
- **Do not modify unrelated projects.** Jana runs several other things on
  overlapping infrastructure — most importantly **Crue Platform** and
  **loc-therapy**, and separately **TCABC Connect**. None of those share
  a Supabase project, Netlify/Cloudflare site, or GitHub repo with
  Polling Center. Nothing in this repository's setup should ever touch
  them; if a task seems to require touching one of them, stop and ask.

## Honesty about verification

- **Never label something browser-tested unless it was actually tested
  in a browser.** A database-level RPC simulation, a syntax check, or
  careful code review is real, valuable verification — but it is not the
  same claim as "tested in a browser," and this project's QA tracker
  (`docs/QA.md`) has repeatedly relied on that distinction to catch real
  bugs (e.g. a JS `null`-vs-`false` coercion bug that only real browser
  exercise surfaced, not SQL-level testing). Keep tiering claims honest:
  say exactly how something was verified, and don't upgrade a
  database-verified or code-reviewed item to "browser-tested" until it
  actually has been, by a human, in a real browser, against the deployed
  site.
