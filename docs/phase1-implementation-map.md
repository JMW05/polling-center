# Phase 1 — Implementation & Migration Map

Status: **planning document — approved for planning purposes; no migration in this map has
been applied and no frontend module extraction has happened yet.** This is the map your
Sept 24 approval asked for before any production schema change. Companion to
`docs/phase-expansion-proposal.md` (the approved design) — this document is the "how and
in what order," not a re-litigation of the "what."

---

## 1. Frontend module structure (approved decision #8)

Proposed now, before any Phase 1 feature work touches the frontend, per your instruction.

**No framework.** I don't have a concrete reason React/Vite would be necessary here, and
`CLAUDE.md` already establishes "no build step/bundler unless explicitly asked" as a
standing rule — introducing one to solve a file-organization problem would be solving it
with a bigger problem. Modern browsers load native ES modules (`<script type="module">`,
`import`/`export`) with no bundler, and Cloudflare Pages already serves nested static
paths with no configuration — this is a pure reorganization, not an architecture change.

```
index.html                    — shell only: mount points, <script type="module" src="js/app.js">
assets/
  favicon.svg / .ico / touch icons   — WWJanaDo mark (§ your item 14)
css/
  tokens.css                  — :root custom properties; theme preset token tables
  base.css                    — resets, typography, layout primitives
  components.css              — buttons, cards, form controls, badges (shared)
  admin.css                   — dashboard / builder / org-settings layout
  public.css                  — respondent-facing layout
  presentation.css            — /present/ full-screen layout
js/
  app.js                      — bootstrap: Supabase client init, router mount, route table
  supabase-client.js          — single createClient() instance + typed RPC call wrappers
  state.js                    — small shared state store (plain pub/sub — no framework)
  router.js                   — existing hash router, extracted as-is (no behavior change)
  themes/
    tokens.js                 — the 5 preset token tables from proposal §9
    apply-theme.js            — platform→org→(poll, Phase 2) cascade resolver; injects the
                                 :root style block; validates every token value against
                                 `^#[0-9a-fA-F]{6}$` before use (XSS guard, proposal §8)
  admin/
    dashboard.js
    poll-builder.js           — core structure editor (existing, extracted)
    poll-builder-questions.js — per-question-type editors, including the 3 new types
    poll-builder-quiz.js      — points / correct-answer / explanation panel
    poll-builder-sections.js  — section grouping panel
    poll-builder-theme.js     — theme tab (Phase 1: read-only link to Org Settings)
    org-settings.js           — theme picker, default timezone (existing, extended)
    draft-recovery.js         — existing local autosave/restore system, extracted as-is
  public/
    poll-response.js          — respondent question rendering + submit, incl. new types
    join.js                   — short join-code entry flow
    results-view.js           — results/aggregate display, incl. ranking + word-cloud viz
  presentation/
    present-view.js           — /present/:pollId full-screen route
    presenter-controls.js     — launch/close/next/reveal, admin-gated
    realtime-channel.js       — per-poll Broadcast subscribe + notify-then-refetch (§3)
  shared/
    question-types.js         — per-type render/validate helpers, shared by builder + respondent
    export-xlsx.js            — client-side workbook builder (SheetJS via CDN, no build step)
    export-csv.js              — existing CSV export, extracted as-is
```

**Sequencing note:** the extraction of *existing* code (router, draft-recovery, CSV export,
current question types, current builder) into this structure happens as its own commit,
with **no behavior change** — verified against the existing QA baseline before any new
capability is layered in. That keeps "we reorganized the file" and "we changed what it
does" as two separately-reviewable things, never one commit doing both.

---

## 2. Presentation-mode Realtime design (refines proposal §2's `0018`, per approval #4)

- **Source of truth stays the database.** `poll_presentation_state` (current question,
  results-revealed flag), `polls.status`, and the aggregate-results RPCs are what every
  client actually renders. Nothing is ever rendered from a Realtime payload directly.
- **Broadcast, not raw Postgres Changes**, and **triggered from the database, not the
  admin's browser.** A trigger function on `poll_presentation_state` (and on the response
  tables, for live counts) calls Supabase's `realtime.send()`/`broadcast_changes()` to emit
  a lightweight notify event — e.g. `{type: 'state_changed'}` — carrying no authoritative
  payload, just a ping. This is more robust than having the admin's client broadcast after
  its own write: it still fires even if the admin's tab closes immediately after the action,
  or if a future path other than the presenter UI changes state.
- **Per-poll topics**, named `presentation:{poll_id}` — never one global channel. A client
  only subscribes while actually viewing that poll's `/present/` route or its live-results
  view, and unsubscribes on navigation away.
- **On receiving a notify event, clients refetch** current state from the DB (existing
  results RPCs + a `get_presentation_state` read), rather than trusting anything in the
  broadcast payload. This is what satisfies "correctness must not depend solely on an
  ephemeral WebSocket event."
- **Fallback poll, not just reconnect-and-hope.** Independent of Broadcast, the presentation
  view also refetches on a low-frequency interval (e.g. every 10–15s) and immediately on
  visibility/reconnect. If a Broadcast event is ever missed (tab backgrounded, brief
  disconnect), state is still eventually correct without the viewer needing to do anything.
- **No Presence.** Not enabled — nothing in Phase 1 needs participant-online tracking, and
  turning it on later is a small, isolated addition rather than something that needs to be
  designed in now.
- **Cost shape:** channels are only open during an active presentation session, not
  per-poll-always-on, keeping message/connection volume well inside the concern your Pro
  plan's allowance raises. If real usage patterns ever suggest this needs to change, that's
  a "come back and ask" conversation, not a default I'd make unilaterally (approval #5).

---

## 3. Capability → migration → code map

| Capability | Migration | Affected tables/functions | Frontend modules | Regression tests | Security tests |
|---|---|---|---|---|---|
| **Module extraction** (no new capability) | none | none | all — moves existing inline code into the §1 structure, unchanged | Full existing QA.md pass, browser-tested, identical behavior before/after | n/a — no logic change, but confirm no secret/key handling changed shape during the move |
| **Theme system** | `0015` | `organizations` (+theme_preset, theme_tokens), `polls` (+theme_override, dormant) | `css/tokens.css`, `js/themes/*`, `js/admin/org-settings.js`, `js/admin/poll-builder-theme.js` | Every existing screen renders correctly under all 5 presets; switching preset live doesn't break layout | `apply-theme.js` token validation rejects a non-hex-shaped `theme_tokens` value (attempted CSS/markup injection test case) |
| **Ranking question type** | `0016` | `questions` (+rank_mode, rank_limit), `save_poll_draft` (new JSONB keys), results RPC | `js/shared/question-types.js`, `js/admin/poll-builder-questions.js`, `js/public/poll-response.js`, `js/public/results-view.js` | Existing single/multi/yesno/rating/text/availability questions unaffected by the widened CHECK; a ranking question round-trips build→respond→results correctly | `option_ids` order is preserved end-to-end (array order = rank) with no reordering introduced by any intermediate query |
| **Word cloud question type** | `0016` | same `questions`/`options` widening; results RPC aggregation only (no new answer storage) | same builder/response modules; `results-view.js` frequency visualization | Free-text ('text') questions still behave identically — word cloud is additive, not a replacement | Confirm `text_answer` is never rewritten/normalized in storage — only in the read-time aggregation query (matches proposal §2's design) |
| **Reaction question type** | `0016` | `options` (+icon) | same builder/response modules; live tallying reuses existing results RPCs | `single_select` questions unaffected by the new nullable `icon` column | Rapid repeated reactions from one respondent behave per `allow_change_vote`, not as unlimited duplicate votes |
| **Rating enhancements** (labels, stars/numeric) | `0016` | `questions` (+rating_min_label, rating_max_label, rating_display) | `question-types.js`, builder + respondent rating UI | Existing rating questions (no labels set) render exactly as today | n/a beyond standard input validation |
| **Quiz workflow** | `0017` | `polls` (poll_type widened, +quiz_reveal_answers), `questions` (+is_scored, points, explanation), `options` (+is_correct), `identified_responses` (+quiz_score, quiz_max_score), scoring RPC | `js/admin/poll-builder-quiz.js`, submission RPC wrapper in `supabase-client.js`, `js/public/poll-response.js` (score display) | Existing poll types unaffected by the widened `poll_type` CHECK; a non-quiz poll's `is_scored`/`points` stay at their defaults and change nothing | **Required, not optional:** inspect the actual network payload (browser devtools, not just code) of `get_public_poll_detail` for a quiz configured to hide answers, before any submission — confirm `is_correct`/`explanation` are absent, not just hidden in the UI |
| **Presentation mode** | `0018` | `polls` (+presentation_enabled, join_code), new `poll_presentation_state` (+RLS), Broadcast trigger | `js/presentation/*`, `css/presentation.css` | Normal (non-presentation) poll response flow is completely unaffected — presentation is additive | Presenter controls (`set_presentation_state`-style RPC) reject a non-org-admin caller exactly like existing admin RPCs; simulate a dropped WebSocket mid-session and confirm the fallback poll still converges to correct state |
| **Sections** | `0019` | `polls` ←< new `sections` (+RLS), `questions` (+section_id, nullable) | `js/admin/poll-builder-sections.js`, minor `poll-response.js` grouping | Existing polls (all `section_id = null`) render as one flat list, byte-for-byte the same as today | n/a — purely structural, admin-authored |
| **Dormant foundations** (governance, conditional logic, webhooks) | `0020` | new `governance_decisions`, `question_logic_rules`, `webhook_endpoints`, `webhook_deliveries` (all +RLS, no RPCs yet) | none — no UI ships against these in Phase 1 | Confirm their existence changes nothing observable anywhere in the app (they're inert) | RLS on each new table reviewed and confirmed admin-scoped at creation, even though nothing reads/writes them yet |
| **xlsx export** | none (app-layer only) | none — reads existing/extended results RPCs | `js/shared/export-xlsx.js` (SheetJS via CDN `<script>`, matching the existing Supabase-JS CDN pattern) | CSV export (existing) unaffected; xlsx output cross-checked against CSV for the same poll | Confirm the workbook is built from the same access-controlled RPC results as the UI — never a raw table read — and that a secret-ballot poll's export contains no voter-identity sheet/column |
| **Favicon** | none | none | `assets/*`, `index.html` `<link rel="icon">` tags | Visual check only | n/a |

---

## 4. Proposed commit sequence

Small and reviewable, per approval #7 — no single commit spans more than one row above.

1. `docs/phase-expansion-proposal.md` + Approval section + this map (**this commit**)
2. Module extraction — existing code moved into the §1 structure, zero behavior change,
   verified against the full existing QA.md baseline
3. `0015` — theme schema + CSS token refactor + 5 presets
4. `0016` — ranking, word cloud, reaction, rating enhancements (likely 3–4 sub-commits,
   one question type at a time, rather than all four in one)
5. `0017` — quiz (schema → scoring RPC → answer-hiding enforcement → UI, in that order,
   with the network-payload check from §3 done before this is called done)
6. `0018` — presentation mode schema + DB-trigger broadcast + `/present/` route + controls
7. `0019` — sections schema + minimal grouped builder UI
8. `0020` — dormant foundations (can land any time after step 1; no dependency on anything
   above — likely bundled with step 7 for convenience, but reviewed as its own diff)
9. xlsx export
10. Favicon swap
11. **Full regression pass** (existing QA.md baseline, browser-tested, plus the
    capability-specific security tests in §3) before Phase 1 is called complete —
    per approval #9, no new workflow is production-ready on schema alone.

I have not started step 2 or written any of `0015`–`0020` yet — that begins only once
you've had a chance to look at this map itself. Flag anything here you'd want reordered,
split further, or want to look at before it starts.
