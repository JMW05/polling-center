# Frontend equivalence harness

A regression check for **refactors that must not change behavior** (it was
written for the ES-module extraction in commit `aec3444`). It loads two
copies of the frontend side by side in headless Chromium, drives both
through the same scripted clicks and typing, and fails if anything
observable differs.

- **"old"**: the frontend exactly as committed at `BASE_REF`, served
  straight out of git (default `cf15b38`, the last commit before the
  module extraction).
- **"new"**: the current working tree.

## What it compares

After each of ~73 steps (public poll list, poll detail and voting for
meeting / choice / election / survey, validation errors, sign-up and
sign-in, admin dashboard, org timezone, poll management, lifecycle
actions, voter-code generation, CSV exports, the poll builder for every
poll type, preview, save, save-and-publish, local draft autosave →
reload → Restore / Discard, the session-expiry → re-sign-in → restore
path, sign-out), it compares:

- the rendered page (`document.body` HTML), header subtitle and admin button,
- every form control's value / checked / disabled / placeholder / display,
- the full computed style of every element in the page,
- `localStorage` contents.

Across the whole run it also compares every backend call the page made
(RPC name and full argument payload, table reads with their filters,
auth calls), downloaded files (CSV contents), `alert()` dialogs, and
uncaught page errors.

## It uses a fake Supabase backend

`fake-supabase.js` replaces the supabase-js CDN script with a small fake
client that returns fixture data and records every call. **Nothing is
sent to the real Supabase project**, and no other network requests are
made: every request the page makes is served from git, the working tree,
or the fake. That means it cannot catch anything that depends on the real
database: RLS, RPC validation, constraints, real auth, email links,
election token hashing, or result-visibility rules as enforced server-side.

## How to run

Requirements: `git`, Node.js 18+, and Playwright with Chromium.

```bash
# one-time, from this directory (or use a global Playwright install)
cd tests/frontend-equivalence
npm install
npx playwright install chromium

# run, from anywhere inside the repo
node tests/frontend-equivalence/run.js
```

It exits `0` and prints `RESULT: IDENTICAL` when the two versions match,
and `1` with a per-step list of differences otherwise. The full capture is
written to a JSON file in your temp directory (the path is printed; override
it with `OUT_FILE=...`).

To compare against a different baseline commit:

```bash
BASE_REF=<commit-or-branch> node tests/frontend-equivalence/run.js
```

The scripted steps assume the UI as it existed at `cf15b38`. A change that
is *supposed* to alter what users see will (correctly) show up as a
difference, and a change to labels or layout may need the scenario in
`run.js` updated.

## Intentionally excluded or normalized

- **Pre-reload read-only calls.** After save / publish / lifecycle actions
  the app calls `navigate(...)` and then `location.reload()`. The
  `hashchange` render can start a few read-only requests before the page
  unloads, and how many depends purely on timing, so the count varies
  from run to run even with identical code. The harness drops only
  read-only calls (`from:*`, `get_*`, `list_*`, `is_platform_owner`,
  `getSession`) that come immediately before a page load, and prints how
  many it dropped. All writes, and everything after each reload, are
  still compared.
- **Randomness and time** are pinned so both sides produce the same
  output: `Math.random` is seeded, `crypto.randomUUID` is deterministic,
  the clock is fixed at 2026-09-20 15:00 UTC, and the browser timezone
  is America/Chicago.
- **Clipboard.** The harness serves over plain `http://`, where
  `navigator.clipboard` doesn't exist, so "Copy link" throws the same
  error on both sides. Copying itself is not tested.
- **Real supabase-js auth events.** The fake only emits `INITIAL_SESSION`
  on subscribe and `SIGNED_IN` / `SIGNED_OUT` on explicit sign-in/out, and
  it answers instantly. The real library also emits `SIGNED_IN` when it
  restores a stored session at startup and on every tab refocus, and real
  requests take time, so overlapping `render()` calls (see "Known issues"
  in `docs/QA.md`) do not show up here.
- **Favicon rendering**, visual appearance at real viewport sizes, and
  anything outside `<body>` apart from the page title are not compared.

## This does NOT replace real browser QA

Passing this harness shows the new code does the same thing as the old
code **against a fake backend**. It is not a browser test in the sense
`CLAUDE.md` and `docs/QA.md` use: it doesn't exercise the real Supabase
project, RLS, auth emails or the deployed site. Nothing may be marked
"browser-tested" or `PASS` in `docs/QA.md` on the strength of this
harness; those rows still need a human in a real browser against the
deployed (or preview) site.
