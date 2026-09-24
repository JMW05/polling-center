# QA status

This tracker distinguishes **how** each item was verified, because that
distinction has already caught real bugs in this project (a JS
`null`-vs-`false` coercion bug in the poll-builder's `anonymous` field
passed database-level RPC simulation but only failed in a real browser).
Per `CLAUDE.md`: never mark something "browser-tested" unless it actually
was, by a human, in a browser, against the deployed site.

## Current real QA status

| Item | Status |
|---|---|
| Admin signup/login | PASS |
| Platform owner bootstrap | PASS |
| Organization creation | PASS |
| Meeting builder renders | PASS |
| Preview | PASS |
| Central timezone display | PASS |
| Meeting Save & Publish after anonymous-null fix | pending browser retest |
| Unsaved form survives token refresh | pending |
| Draft autosave indicator appears | pending |
| Hard refresh Restore/Discard flow | pending |
| Restore returns all form fields | pending |
| Failed save preserves local draft | pending |
| Successful save clears recovery copy | pending |
| WWJanaDo favicon shows in the browser tab (and as the iOS home-screen icon) | pending (visual check) |
| Frontend module extraction (zero behavior change) — full baseline re-run on the branch preview | pending (automated headless parity check vs. the pre-extraction `index.html` against a stubbed backend: identical — not a browser test) |

## Known issues (pre-existing — not regressions from the module extraction)

Both behave identically in the pre-extraction single-file `index.html`
(`cf15b38`) and in the ES-module version: the frontend equivalence
harness (`tests/frontend-equivalence/`) captures the same behavior on
both sides. Recorded here so they aren't mistaken for regressions; not
yet fixed.

| Issue | Status |
|---|---|
| **Draft poll "Edit" button doesn't leave the editor open.** On a draft poll's admin page, clicking Edit navigates to `#/admin/edit/<id>`, but the lifecycle-button handler then navigates back to `#/admin/poll/<id>` and reloads, so the admin lands back on the poll page. Going directly to `#/admin/edit/<id>` works. | pre-existing, open (not fixed yet) |
| **"Your sign-in session expired…" message is never visible.** When a save fails because the Supabase session really expired, the builder shows that message, then immediately signs out and re-renders to the sign-in screen, which wipes it before the admin can read it. Draft restoration after signing back in still works (the Restore/Discard prompt appears). | pre-existing, open (not fixed yet) |

## Context on the pending items

The "pending" rows above all belong to the local draft-recovery/autosave
system added to the poll builder (debounced autosave to browser storage,
scoped per admin + organization + poll, a "Draft saved locally" status
line, and a Restore/Discard prompt on return). It was implemented and
verified by code review and a JavaScript syntax check
(`node --check`), but — same as the `anonymous`-null fix before it —
has not yet been exercised by a human in a real browser against the
deployed site. Until each row above is actually clicked through in a
browser, it stays "pending," not "PASS."

To retest, at minimum:

1. Start editing a poll (any type), let the "Draft saved locally"
   indicator appear, then hard-refresh the page — confirm the
   Restore/Discard prompt appears and Restore brings back every field
   (title, description, poll type, questions, options/time slots, access
   mode, timezone, open/close times, allow-change setting, results
   visibility, respondent-identity setting).
2. Repeat, but choose Discard — confirm it starts clean.
3. Start editing, force a save failure (e.g. briefly disconnect), confirm
   the local draft is still there afterward.
4. Complete a successful Save & Publish — confirm the local draft copy
   for that poll is gone afterward (no stale Restore prompt on return).
5. Create one real poll of each type (Meeting, Survey, Choice, Secret
   Choice, Election) through to a successful Save & Publish, to close out
   the "Meeting Save & Publish after anonymous-null fix" row and extend
   the same confirmation to the other poll types.
