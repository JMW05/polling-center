# Frontend regression harness

Two checks live here:

- **`run.js` — old-vs-new equivalence** (below): does the current tree do
  exactly what an earlier commit did?
- **`auth-startup.js` — startup / auth-event behavior** (see "Startup and
  auth events" further down): does the app render once and ignore
  same-user auth noise, using the real supabase-js library?

## Equivalence (`run.js`)

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

Requirements: `git`, Node.js 18+, Playwright with Chromium, and (for
`auth-startup.js` only) the pinned `@supabase/supabase-js` devDependency.

```bash
# one-time, from this directory (or use a global Playwright install)
cd tests/frontend-equivalence
npm install
npx playwright install chromium

# run, from anywhere inside the repo
node tests/frontend-equivalence/run.js
node tests/frontend-equivalence/auth-startup.js
# or, from this directory: npm test  (runs both)
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
  requests take time, so overlapping `render()` calls can't show up in
  `run.js`. `auth-startup.js` covers exactly that.
- **Favicon rendering**, visual appearance at real viewport sizes, and
  anything outside `<body>` apart from the page title are not compared.

## Startup and auth events (`auth-startup.js`)

Loads the **real supabase-js UMD build** (the pinned `@supabase/supabase-js`
devDependency) in headless Chromium, so the library's own auth event
sequence is exercised. Only Supabase's HTTP endpoints are faked, with a
fixed 80 ms latency, so nothing reaches the real project. A small
observer records the auth events the app's client emits and counts how
often `#app` is torn down and rebuilt. It doesn't change app behavior.

It asserts, with pass/fail per check:

- signed-out first load: one UI, one `organizations` and one
  `list_public_polls` request;
- restored signed-in session: supabase-js emits `SIGNED_IN` at startup,
  yet there is one visible UI (one org selector, one tab bar, one "No
  open polls" message), one `organizations`, one `is_platform_owner`, one
  `org_admins` and one `list_public_polls` request;
- tab hide → show: supabase-js emits another `SIGNED_IN` for the same
  user, and there are no rebuilds and no new app requests;
- the poll builder loaded with a restored session: one form, and a value
  typed immediately before a tab switch (inside the 800 ms local-draft
  debounce) is still there afterwards;
- sign-out from the dashboard: one `SIGNED_OUT`, public list shown once;
- sign-in again as the same user, and then as a different user: one
  `SIGNED_IN`, one admin-context load (for the right user id), and the
  dashboard shown once;
- overlapping non-auth renders: a second render started while the first
  organizations request is in flight produces one list and one request,
  and leaving a poll page before its data arrives doesn't let the
  abandoned render overwrite the header.

```bash
node tests/frontend-equivalence/auth-startup.js                  # working tree
BASE_REF=6330a45 node tests/frontend-equivalence/auth-startup.js # an older commit
```

Run against `6330a45` (before the startup/auth fix) it fails 17–18 of
the 43 checks (the exact count depends on timing), which shows it detects the
original bug; against the fix it passes 43/43. It exits `0` / `RESULT: PASS` when every check passes.

## This does NOT replace real browser QA

Passing these checks shows the frontend behaves as expected **against a
fake backend** (fixture data, faked HTTP). It is not a browser test in the sense
`CLAUDE.md` and `docs/QA.md` use: it doesn't exercise the real Supabase
project, RLS, auth emails or the deployed site. Nothing may be marked
"browser-tested" or `PASS` in `docs/QA.md` on the strength of this
harness; those rows still need a human in a real browser against the
deployed (or preview) site.
