# Polling Center — Phase Expansion Proposal

Status: **APPROVED 2026-09-24 (see Approval section below).** Schema is unchanged as of
this commit — approval covers the design, not yet the migrations themselves. Those are
tracked separately in `docs/phase1-implementation-map.md`.
Scope: your Sept 24 direction to expand Polling Center into polls, surveys/forms, meeting
scheduling, quizzes, live audience engagement, board/committee decisions, and secure
organizational voting — without hard-coding a large number of top-level poll types.

This reflects a full read of `CLAUDE.md`, `docs/architecture.md`, `docs/QA.md`,
`docs/deployment.md`, and all 14 applied migrations (`0001`–`0014`), plus the current
`save_poll_draft` definition and the `polls`/`questions`/`options` schema, read directly
from this repo before writing anything below.

---

## Approval — 2026-09-24

Jana reviewed this proposal and approved it with the following decisions, recorded here
verbatim in substance so the design record stays version-controlled alongside the design
itself:

1. **Workflow/question-type split — approved as proposed.** Workflows stay bounded to the
   seven named in §1 (Quick Poll/Decision, Survey/Form, Meeting Availability, Quiz, Live
   Session, Election, Governance/Official Vote). Question types stay the extensible layer.
   New question capabilities must not become new top-level workflows.
2. **Governance-vs-election split — approved as proposed.** The existing election rule
   (ballots are secret/anonymous, unconditionally) is preserved exactly as-is. Governance/
   Official Vote stays a separate workflow specifically so it can support identified
   roll-call votes, motions, bylaws amendments, quorum, thresholds, abstentions, and
   certification — none of which may be achieved by weakening or generalizing the
   election anonymity constraint.
3. **Theme system — approved as a token-based system.** Warm stays the default. The four
   other presets proceed as designed in §9, contingent on each passing the documented
   contrast/accessibility check (they do, as shown). Palettes must be implemented as
   reusable design tokens/CSS custom properties, never hard-coded per-component, so preset
   colors can change later without a structural rewrite. Organization theme overrides the
   platform default; the schema supports a future poll/session-level override (already
   reflected as the dormant `polls.theme_override` column in §2's `0015` migration).
4. **Realtime — approved, Pro plan confirms availability.** Presentation mode uses Supabase
   Realtime, preferring **Broadcast** over building primarily on raw Postgres Changes.
   The database remains the sole source of truth for poll/session state, open/closed
   state, aggregate responses, current question, and result visibility — Realtime's job is
   to *notify* connected clients that something changed so they refetch/update promptly,
   not to *carry* the authoritative state itself. Correctness must not depend solely on an
   ephemeral WebSocket event. Use dedicated per-poll/session topics, never one global
   channel. Presence is not enabled unless participant-online tracking becomes an actual
   requirement. (This refines and supersedes the more generic "Realtime, tier permitting"
   note in §2's `0018` migration — see `docs/phase1-implementation-map.md` for the worked
   design.)
5. **Cost control.** No increase to Supabase compute, no disabling the spend cap, and no
   new paid infrastructure on account of Realtime without asking first. The current Pro
   Realtime allowance is to be treated as sufficient for Phase 1; channel/topic design
   should be efficient (active only during live presentation sessions, not always-on per
   poll) specifically so it stays within that allowance.
6. **This document** is committed now, together with this Approval section, so the design
   decision is version-controlled rather than left as an untracked file.
7. **Implementation approach.** Proceed incrementally. Before any migration is written
   against production, produce a implementation map covering, per capability: migration
   number, affected tables/functions, frontend modules, regression tests, and security
   tests. Then implement Phase 1 in small, reviewable commits — no single giant migration,
   no single giant frontend rewrite. (Delivered as `docs/phase1-implementation-map.md`,
   committed alongside this approval.)
8. **Frontend maintainability.** Before substantial Phase 1 functionality is added, propose
   a minimal static-module file structure that keeps working cleanly on Cloudflare Pages —
   no React/Vite or other framework unless a concrete reason makes one necessary. (Proposed
   in `docs/phase1-implementation-map.md`, §"Frontend module structure" — no framework is
   proposed; native ES modules only.)
9. **Existing functionality is protected.** Meeting Availability, Choice/Decision, Survey,
   and Election remain the regression baseline. Before Phase 1 is considered complete, the
   existing browser QA plus security checks are rerun — a new workflow is never called
   production-ready on the strength of its schema existing.

---

## 0. Bottom line

Everything proposed here is **additive**: new nullable columns, new columns with safe
defaults, new tables, and CHECK constraints that only *widen* (never narrow) what's
already allowed. Nothing renames, drops, or re-scopes an existing column, table, RPC
signature, or RLS policy. The one place a naive design could have weakened the existing
"every election is anonymous" guarantee — governance/roll-call votes — is deliberately
routed around that guarantee instead of through it (details in §6). Nothing here requires
a new Supabase project, new paid infrastructure, or leaving Cloudflare + this Supabase
project.

**Recommendation:** proceed with the Phase 1 scope in §3. Nothing in it destabilizes
Meeting, Choice, Survey, or Election.

---

## 1. Proposed information architecture

### The reframe

Today `polls.poll_type` is a 4-value CHECK constraint (`meeting`, `choice`, `election`,
`survey`) and every poll-type-specific rule is a CHECK constraint on that column. Your
instruction is not to keep piling workflow after workflow into that same pattern forever.
The fix isn't "no more values ever" — it's **separating two things that are currently
fused**:

- **Workflow** — the small, bounded set of use-case templates a creator picks from
  when starting a new poll (Quick Poll, Survey/Form, Meeting, Quiz, Live Session,
  Election, Governance Vote). This stays a short, closed list — it's *supposed* to be
  enumerable, the same way it already is today.
- **Question type** — the reusable, composable building block every workflow is built
  out of (single choice, multi-select, yes/no, rating, ranking, text, word cloud,
  availability, reaction). This is the layer that actually grows, and it already lives
  in its own table (`questions.question_type`) separate from `polls.poll_type` — that
  separation already exists in the current schema and is exactly right. We extend it,
  we don't duplicate it.

So: **"Live Session" is not a new top-level poll type.** Presentation mode, live
tallying, and reaction questions are capabilities any workflow can turn on (a Quick Poll,
a Quiz, or a Survey question can all be presented live) — modeling it as its own
`poll_type` would recreate the exact problem you flagged. It becomes a `presentation_enabled`
flag plus a couple of supporting columns/table (§2), not a fifth-or-sixth hard-coded type.

**Governance/Official Vote** is also not folded into the existing `election` type,
for a different reason: `election` currently *always* means anonymous secret ballot
(`election_is_anonymous` CHECK, unconditional). Governance votes need to support
roll-call (identified) *or* secret ballot depending on the decision. Reusing `election`
would mean loosening a constraint that exists specifically to guarantee secret-ballot
integrity — which you've told me multiple times not to do, in this session and prior
ones. So it gets its own `poll_type = 'governance_vote'`, with its own,
separately-scoped anonymity rule. The original `election` constraint is untouched.

Net result: `poll_type` grows from 4 values to **6** (`meeting`, `choice`, `election`,
`survey`, `quiz`, `governance_vote`). That's the entire "top-level type" footprint for
everything in your list — Live Session, Board Decisions, Reaction Polls, Ranking, Word
Cloud, and Rating all live inside the question-type layer or as capability flags, not as
new poll types.

### Entity model (additions in **bold**)

```
organizations ──< org_admins
      │
      ├─ theme_preset, theme_tokens              (theme, §2.1)
      │
      └──< polls ──< sections                     (multi-page, §2.6)
             │  │
             │  ├─ theme_override                 (dormant in Phase 1, §2.1)
             │  ├─ presentation_enabled, join_code (§2.4)
             │  └── 1:1 poll_presentation_state    (§2.4)
             │  └── 1:1 governance_decisions       (dormant in Phase 1, §2.5)
             │
             ├──< questions ──< options
             │      │              │
             │      ├─ rank_mode, rank_limit        (ranking, §2.2)
             │      ├─ rating_min/max_label,         (rating, §2.2)
             │      │  rating_display
             │      ├─ is_scored, points, explanation (quiz, §2.3)
             │      │              │
             │      │              └─ is_correct     (quiz, §2.3)
             │      │              └─ icon            (reaction, §2.2)
             │      │
             │      └──< question_logic_rules        (dormant schema, §2.7)
             │
             ├──< identified_responses (+ quiz_score, quiz_max_score)
             ├──< anonymous_ballots            (unchanged — see §8)
             └──< webhook_endpoints ──< webhook_deliveries  (dormant, §2.8)
```

---

## 2. Proposed database additions / migrations

All numbered from `0015`, continuing the existing style: many small, single-purpose,
reviewable migrations rather than one large one. Each is additive-only.

### 0015 — Theme system

```sql
alter table organizations
  add column theme_preset text not null default 'warm'
    check (theme_preset in ('warm','classic_navy','black_gold','forest_cream','burgundy_blush','custom')),
  add column theme_tokens jsonb; -- null = use the named preset's canned tokens as-is;
                                  -- non-null = overlay these keys on top of the preset
                                  -- (or the full custom set, when theme_preset='custom')

-- Added now so Phase 2 (per-poll override) needs no further migration.
-- Stays null / unused in Phase 1 — no UI reads or writes it yet.
alter table polls add column theme_override jsonb;
```
Risk: **low**. Two nullable/defaulted columns on existing tables.

### 0016 — Question type expansion (ranking, word cloud, reaction) + rating enhancements

```sql
alter table questions drop constraint questions_question_type_check;
alter table questions add constraint questions_question_type_check
  check (question_type in ('single_select','multi_select','yesno','rating','text',
                            'availability','ranking','word_cloud','reaction'));

alter table questions
  add column rank_mode text check (rank_mode in ('rank_all','rank_top_x')),
  add column rank_limit int check (rank_limit is null or rank_limit >= 1),
  add column rating_min_label text,
  add column rating_max_label text,
  add column rating_display text not null default 'numeric'
    check (rating_display in ('numeric','stars'));

alter table options add column icon text; -- reaction emoji/icon key; unused by other types
```
Widening a CHECK constraint is metadata-only — every existing row already satisfies a
*subset* of the new allowed set, so no table rewrite, no risk to existing data.

Storage design notes (no new tables needed):
- **Ranking** reuses `option_ids uuid[]` on `identified_answers`/`anonymous_ballot_answers` —
  Postgres arrays preserve order, so the array's element order *is* the respondent's rank
  order. No new answer table.
- **Word cloud** reuses the existing `text_answer` column (it's architecturally a `text`
  question with a different results visualization). Frequency normalization (lowercasing,
  punctuation-stripping, counting) happens **only inside the results-aggregation query** —
  `text_answer` itself is never rewritten, so "don't permanently destroy the original text"
  falls out of the design rather than needing separate enforcement.
- **Reaction** reuses the `options` table exactly like `single_select` (each reaction choice
  — thumbs up, heart, etc. — is an option row), just rendered as icon buttons and typically
  paired with `allow_change_vote = true` for live re-tallying. `options.icon` is the only
  new column it needs.

Risk: **low**. New nullable columns + a widened CHECK.

### 0017 — Quiz scoring

```sql
alter table polls add constraint polls_poll_type_check_v2 check (
  poll_type in ('meeting','choice','election','survey','quiz','governance_vote')
); -- replaces the existing poll_type check the same way (widen, don't narrow)

alter table questions
  add column is_scored boolean not null default false,
  add column points numeric not null default 0 check (points >= 0),
  add column explanation text;

alter table options add column is_correct boolean not null default false;

alter table polls add column quiz_reveal_answers text not null default 'after_submission'
  check (quiz_reveal_answers in ('after_submission','after_close','manual'));

alter table identified_responses
  add column quiz_score numeric,
  add column quiz_max_score numeric;
```
Scoring happens **server-side**, inside the submission RPC (either extending
`submit_identified_response` or a dedicated `submit_quiz_response` — a Phase 1
implementation decision, not a schema one): the RPC computes the score from
`options.is_correct` against the submitted `option_ids`, writes it to
`identified_responses.quiz_score`, and returns it to the caller. It is never computed
client-side and trusted.

**Security-relevant:** `get_public_poll_detail` (and any other pre-submission payload)
must omit `options.is_correct` and `questions.explanation` whenever
`quiz_reveal_answers <> 'manual'` has not yet been satisfied for that respondent — this is
a required RPC-layer filter, called out again in §8.

Risk: **low** schema risk. The RPC-layer answer-hiding logic is the part that needs
careful review and a real (not just code-reviewed) test before ship.

### 0018 — Presentation mode

```sql
alter table polls
  add column presentation_enabled boolean not null default false,
  add column join_code text unique;

create table poll_presentation_state (
  poll_id uuid primary key references polls(id) on delete cascade,
  current_question_id uuid references questions(id) on delete set null,
  results_revealed boolean not null default false,
  updated_at timestamptz not null default now()
);
-- RLS: admin-write (is_org_admin), public-read (so /present/ and respondent
-- clients can subscribe) — mirrors the existing get_public_poll_detail pattern,
-- never exposes anything beyond current-question-pointer + a boolean.
```
A join code is a short, human-typeable alternative to scanning the QR/opening the direct
link — it isn't a secret and doesn't need to be treated like one; it just routes to the
same public poll view a direct link already would.

Live counts/results use Supabase **Realtime** on `poll_presentation_state` and the
response tables where practical — worth confirming this is included in the current
Supabase plan tier before relying on it (I did not check billing/plan details as part of
this review). If it isn't available or isn't wanted, the fallback is a short-interval
client-side refresh against the existing results RPCs — slightly less snappy, zero new
infrastructure either way.

Risk: **low**. New table + two columns; nothing existing is touched.

### 0019 — Sections (multi-page foundation)

```sql
create table sections (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  order_index int not null default 0,
  title text not null,
  description text not null default '',
  unique (poll_id, order_index)
);

alter table questions add column section_id uuid references sections(id) on delete set null;
```
`section_id` is nullable and every existing question has `section_id = null`, which means
"no sections — render as one flat list," i.e. exactly today's behavior. Zero data
migration needed. Full paginated multi-page rendering is Phase 2; Phase 1 can ship this
schema plus (optionally) a minimal "group questions under a heading" builder UI for
Survey/Form, still on one scrollable page.

Risk: **low**.

### 0020 — Dormant foundations: governance, conditional logic, webhooks

These three are schema-only in Phase 1 — new tables, RLS-locked from day one, no RPCs and
no UI wired to them yet. Shipping them now means Phase 2/3 never needs a schema redesign
to add sections 8/9/12, only new RPCs and UI against tables that already exist and are
already reviewed.

```sql
-- Governance / official vote metadata (1:1 extension of polls, poll_type='governance_vote')
create table governance_decisions (
  poll_id uuid primary key references polls(id) on delete cascade,
  meeting_title text not null,
  motion_text text not null,
  eligible_voter_count int,
  quorum_requirement int,
  voting_threshold text not null default 'simple_majority'
    check (voting_threshold in ('simple_majority','two_thirds','unanimous')),
  vote_type text not null check (vote_type in ('roll_call','secret_ballot')),
  certified boolean not null default false,
  certified_at timestamptz,
  certified_by uuid references auth.users(id)
);

-- Conditional logic (evaluation engine is Phase 3 — this is just the normalized rule shape)
create table question_logic_rules (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  trigger_question_id uuid not null references questions(id) on delete cascade,
  trigger_option_id uuid references options(id) on delete cascade,
  trigger_operator text not null default 'equals' check (trigger_operator in ('equals','not_equals')),
  action text not null check (action in ('show','hide','jump_to_section','end_form')),
  target_question_id uuid references questions(id) on delete cascade,
  target_section_id uuid references sections(id) on delete cascade,
  order_index int not null default 0
);

-- Integration foundation (dispatch mechanism is Phase 3 — see §5 and §8)
create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  poll_id uuid references polls(id) on delete cascade, -- null = org-wide
  url text not null,
  secret text not null, -- HMAC signing secret, generated server-side, shown once
  event_types text[] not null default '{response_submitted}',
  enabled boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','delivered','failed')),
  attempts int not null default 0,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now()
);
```
Every table above ships **with RLS enabled and admin-scoped policies in the same
migration**, mirroring the existing `polls`/`questions`/`options` pattern — never created
open and locked down later.

Governance's anonymity rule is enforced the same way the existing boolean-null guards are
(migration `0014`'s pattern): inside `save_poll_draft`'s PL/pgSQL validation, not a
cross-table CHECK constraint (Postgres can't express those anyway) —
`vote_type = 'secret_ballot'` requires `polls.anonymous = true`, `vote_type = 'roll_call'`
requires `polls.anonymous = false`. Same "fail loudly, never coalesce" style as the rest
of this codebase.

Risk: **low**. All new tables, nothing references or alters existing ones except adding
RLS-locked children.

---

## 3. Phase 1 — safe to implement now

Everything in §2 (migrations `0015`–`0020`) plus:

- Frontend: replace hard-coded navy values with CSS custom properties; inject
  `:root{--pc-color-*}` from the resolved org theme at app/org load. Ship the 5 presets
  (palettes + contrast check in §9). No build step added — still one static file.
- Builder + respondent UI for **ranking, word cloud, reaction** questions; rating labels
  + stars/numeric display toggle.
- **Quiz** workflow end-to-end: correct-answer/points/explanation authoring, server-side
  scoring, answer-hiding enforcement, respondent-facing score display.
- **Presentation mode**, basic: `/present/:pollId` route, QR code, join code entry, live
  response count, live/refreshing aggregate results, reveal/hide toggle, launch/close/next
  controls for the authorized presenter. Explicitly generic — works screen-shared through
  anything; no Teams/PowerPoint-specific code.
- Sections: schema + a minimal "group these questions under a heading" builder control for
  Survey/Form, rendered as one scrollable page (full pagination is Phase 2).
- xlsx export, client-side (SheetJS or similar via the same CDN-script pattern already used
  for the Supabase client — no build step, no server compute). CSV stays as-is.
- Favicon swap to the WWJanaDo logo. No branding added to respondent-facing poll pages.
- Regression pass (§10) on Meeting/Choice/Survey/Election before and after this batch.

Everything in this phase is either a pure schema addition or additive to existing RPCs'
JSONB payloads (see §6) — nothing here needs an existing RPC's parameter list to shrink,
an existing constraint to loosen, or an existing table's meaning to change.

---

## 4. Phase 2

- Activate `polls.theme_override` — per-poll theme picker in the builder, same cascade
  logic already built in Phase 1, just adding the third tier.
- Full multi-page Survey/Form rendering: section-by-section navigation, progress
  indicator, using the `sections` table from Phase 1.
- **Governance/Official Vote** workflow, fully wired: `governance_decisions` UI
  (motion text, quorum, threshold, roll-call vs. secret-ballot picker), a server-side
  `get_governance_result()` RPC computing quorum-met/threshold-met from the appropriate
  response table depending on `vote_type`, and the certified/closed status flow.
- Conditional logic: a minimal rule-row builder (trigger question → operator → value →
  action → target) reading/writing `question_logic_rules`, plus the evaluation logic in
  the respondent-facing renderer. Deliberately not a visual flow-builder — a straightforward
  list of IF/THEN rows, per your instruction not to build a "giant logic-builder UI" yet.
- Presentation mode polish: Realtime wiring if not already done in Phase 1, richer live
  visualizations (e.g. live word cloud, live ranking aggregate).
- Any response/privacy-setting normalization (§ your item 5) that Phase 1 didn't fully
  cover once real usage surfaces gaps.

## 5. Phase 3 / integrations — document now, build later

Per your explicit instruction, these are documented as roadmap, not built:

- Webhook **dispatch**: wiring `webhook_endpoints`/`webhook_deliveries` to an actual
  outbound call. Candidate mechanism: Postgres's `pg_net` extension (async HTTP from
  within Postgres — a Supabase-supported extension on the existing project, not a new
  paid service) triggered off response-submission, with retry/backoff tracked in
  `webhook_deliveries`. Needs its own security pass before activation (§8) — not a Phase 1
  or 2 item.
- Microsoft Teams app / PowerPoint add-in / Google Slides & Workspace add-on
- Google Calendar / Outlook Calendar
- Slack, Resend, PayPal, Stripe
- Zapier / Make
- A documented public API/webhook surface for third parties generally

None of these are Phase 1 or Phase 2 dependencies — the foundation tables from §2.0020
exist so that when you do prioritize one of these, it's new RPCs and UI against
already-reviewed schema, not a redesign.

---

## 6. Conflicts with the current schema

**One real tension, resolved, not left open:** roll-call (identified) governance votes
vs. the existing `election_is_anonymous` constraint, which unconditionally requires
`anonymous = true` for `poll_type = 'election'`. Resolved by giving governance votes their
own `poll_type = 'governance_vote'` with independently-scoped anonymity logic, rather than
loosening the existing election constraint. The original constraint is not touched by any
migration in this proposal.

No other conflicts found. The `question_type` and `poll_type` CHECK constraints both only
need widening (existing values stay valid). `save_poll_draft` already takes questions as a
`jsonb` array — most of the new per-question fields (rank mode, rating labels, quiz
points/correct-answer, reaction icon) can be added by recognizing new optional keys inside
that existing JSON shape, with **no RPC signature change at all**. Only genuinely new
poll-level settings (theme, presentation, quiz-reveal-timing) need either new named
parameters (with defaults, so existing calls keep working) or dedicated new RPCs — I'd
recommend deciding that case-by-case at implementation time rather than pre-committing
here, but flagging now that it's a real decision point, not an afterthought.

---

## 7. Migration risk

**Low**, across nearly everything proposed — every migration in §2 is either
`add column ... [not null default ...] | [nullable]`, a widened CHECK constraint (existing
rows already satisfy a subset of the new allowed set — no rewrite, no revalidation risk),
or a brand-new table with its own RLS from creation. None of it can fail against existing
data, because none of it constrains existing data more tightly than today.

**Medium-risk items, called out specifically so they get real attention, not skipped:**
- Any change to `save_poll_draft`'s behavior — extend it via the transaction-rollback
  test technique already used in this project (disposable test org, real RPC call,
  `rollback`) before it ever touches production data, the same way the `anonymous`-null
  fix was verified.
- Enabling Realtime on new tables — confirm plan-tier inclusion before building on it.
- `pg_net` for webhook dispatch (Phase 3 only) — new outbound-network capability from
  inside the database deserves its own review before it's turned on, independent of this
  proposal's Phase 1/2 scope.

---

## 8. Security implications

- **Quiz answer leakage**: `get_public_poll_detail` and any other pre-submission payload
  must strip `options.is_correct` and `questions.explanation` whenever
  `quiz_reveal_answers <> 'manual'` hasn't yet been satisfied for that respondent. This is
  a required RPC-layer filter, not just a frontend hide — a browser dev tools check must
  not reveal it either.
- **Governance/secret-ballot separation**: unchanged and untouched. Roll-call governance
  votes are structurally a different path (`identified_responses`) from secret-ballot
  governance votes (`anonymous_ballots`, still with zero identity-linking columns) — the
  existing unlinkability design that protects elections protects secret-ballot governance
  votes identically, because it's the same tables.
- **Webhooks (Phase 3)**: admin-supplied destination URLs are a classic SSRF vector —
  needs URL validation/allowlisting before dispatch is activated, not after. HMAC-sign
  payloads with the per-endpoint secret so receivers can verify authenticity. Payload
  builders must be built from the same public-safe result views used elsewhere in the
  app — never a raw table dump — and must never include secret-ballot selections
  together with any identity, matching your explicit instruction.
- **Theme tokens as rendered CSS**: `theme_tokens`/`theme_override` are admin-authored
  JSON rendered into a `<style>` block in every visitor's browser. This must never be
  string-interpolated directly into `innerHTML` — each known token key's value should be
  validated against a strict pattern (e.g. `^#[0-9a-fA-F]{6}$`) before use, so a
  compromised or careless admin account can't smuggle arbitrary CSS/markup through a
  "custom theme" field. Small thing, but worth stating explicitly since it's new
  user-authored content flowing into every respondent's page.
- **Every new table ships with RLS from its own migration**, admin-scoped the same way
  `polls`/`questions`/`options` already are — never created open.
- **xlsx export** must be built from the same access-controlled RPC results already
  gated by `results_visibility`/anonymity rules, never a direct table read — same rule
  that already structurally prevents voter-identity leakage in exports today (there's
  nothing to join, by design), just stated explicitly so the export code doesn't
  accidentally introduce a join that didn't exist before.

---

## 9. Theme presets — proposed tokens (contrast-checked, WCAG AA)

Your Warm default, verified: all text/button pairs pass AA (4.5:1 normal text, 3:1
large/UI) **except** white text on the accent gold (`#D4A229`) — 2.33:1, fails. Use the
existing dark text color (`#2A211D`) on accent-colored elements instead (6.75:1) — never
white-on-accent. Every other pair in your spec passes comfortably (13–15:1 for body text).

Proposed tokens for the other four presets, contrast-checked the same way (full pairs
computed, not eyeballed):

| Preset | bg | surface | text | primary | primary-dark | accent | soft-accent | success | error |
|---|---|---|---|---|---|---|---|---|---|
| Classic Navy | #FFFFFF | #F5F7FA | #1B2430 | #1F3A5F | #14263D | #2F6FA6 | #DCE6F0 | #2E7D46 | #C0392B |
| Black + Gold | #17140F | #211C15 | #F5EFE2 | #C9A227 | #6B5410 | #E8C76B | #3A2F1A | #356E42 | #B23830 |
| Forest + Cream | #F7F3E8 | #FBF8F0 | #24301F | #3F6B3C | #2C4B29 | #C08A3E | #DCE6D2 | #3F6B3C | #A83F35 |
| Burgundy + Blush | #FDF6F5 | #FFFFFF | #2E1A1C | #7A2333 | #551724 | #D98A93 | #F3D9DC | #4F7A46 | #A83F35 |

Notes:
- **Black + Gold** is the one dark-surfaced preset — its "primary-dark," "success," and
  "error" values are deliberately shifted lighter than you might expect for a dark theme,
  specifically so light text stays AA-compliant on them (the first pass I ran on more
  intuitive darker values failed at 3.0–3.4:1; these pass at 5.3–6.3:1).
- On **Black + Gold**, buttons using the gold `primary`/`accent` colors as backgrounds
  should use dark text (`#17140F`), not light — same rule as the Warm accent.
- Semantic colors (success/error) are kept in a recognizable green/red family across every
  preset rather than reskinned to match each palette's hue, on purpose — familiarity
  matters more than palette purity for "this saved" / "this failed" signals.
- These four are proposed defaults, not finalized — happy to adjust hue/mood on any of
  them, but whatever changes, I'd re-run the same contrast check before it ships.

---

## 10. Proposed UI navigation

- **New poll** opens a workflow-template picker (Quick Poll/Decision, Survey/Form,
  Meeting Availability, Quiz, Live Session, Election, Governance Vote — the last shown
  but disabled/"Phase 2" until built) instead of today's implicit 4-type choice. Each
  template pre-fills sensible defaults into the *same* underlying builder — there is no
  separate builder per workflow.
- **Poll builder** gains, as tabs/panels appear only when relevant: a **Theme** tab
  (Phase 1: read-only, "uses your organization's theme — change it in Org Settings";
  Phase 2: full override), a **Sections** panel (once questions exist), a **Scoring**
  panel (quiz workflow only), a **Presentation** panel (join code, QR, enable toggle), and
  a **Logic** tab (Phase 2, hidden until built).
- **Org Settings** (extending whatever admin-org panel exists today, alongside the
  existing default-timezone setting) gains a **Theme** picker: preset gallery + a
  custom-token editor for the `custom` preset.
- New respondent-facing **`/present/:pollId`** (or join-code entry) full-screen route,
  separate from the normal poll-response view, with presenter controls gated behind the
  same `is_org_admin` check every other admin action already uses.
- A small **"Join a live poll"** entry point (short-code field) alongside the existing
  direct-link flow, for respondents who got a code rather than a URL.

---

## 11. Estimated implementation sequence

Framed as stages within Phase 1 with real dependencies, not calendar dates (you haven't
asked for a timeline and I'd rather not fabricate one):

1. **Migration `0015` (theme) + CSS token refactor.** No dependencies on anything else in
   this plan — ships first, immediately visible, low risk, good confidence-builder before
   touching anything RPC-related.
2. **Migration `0016` (ranking / word cloud / reaction / rating enhancements)** +
   `save_poll_draft` JSONB handling for the new question fields + results-RPC aggregation
   + builder/respondent UI for the three new question types.
3. **Migration `0017` (quiz)** + scoring RPC + answer-hiding enforcement + quiz UI. Depends
   on nothing from step 2 technically, but sequenced after it since quiz questions are
   built from the same single/multi/yesno types step 2's UI work will have just touched.
4. **Migration `0018` (presentation mode)** + `/present/` route + controls. Can run in
   parallel with step 3 — no shared surface area.
5. **Migration `0019` (sections)** + minimal grouped-question builder UI.
6. **Migration `0020` (dormant governance/logic/webhook foundations)** — no urgency, no UI
   dependency, can ship whenever convenient, even bundled with step 5.
7. **xlsx export** (client-side, no migration) — any time after step 2, since it reads
   already-extended RPC output.
8. **Favicon swap** — trivial, any time, no migration.
9. **Regression pass** on Meeting/Choice/Survey/Election — both *before* this batch starts
   (a real baseline) and *after* each migration lands, not just once at the end. I'd carry
   this forward into `docs/QA.md` the same way the draft-recovery and anonymous-null work
   was tracked last round: pending until a human actually clicks through it in a browser,
   never marked PASS from code review alone.

Phase 2 and Phase 3 sequencing is in §4/§5 above — I'd revisit the exact order once Phase 1
is live and you've seen how the theme/quiz/presentation work actually lands, rather than
locking it in now.

---

## What I'd want from you before starting Phase 1

1. Sign-off on the workflow/question-type split in §1 — this is the one decision
   everything else hangs off of.
2. Sign-off on the `governance_vote` vs. reusing `election` call in §6 — this is the one
   place a wrong call could touch the secret-ballot guarantee, so I want that agreed
   explicitly rather than assumed.
3. Any preference on the four non-Warm preset palettes in §9, or "ship as proposed."
4. Confirmation on whether your Supabase plan includes Realtime (affects presentation-mode
   implementation, not its schema).

Once you've reviewed, I'll write the actual `0015`–`0020` migration files, run them through
the same transaction-rollback verification the earlier bug-fix work used, and only then
touch the frontend — same incremental, non-rewrite approach as everything so far.
