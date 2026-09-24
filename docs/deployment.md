# Deployment

## Target

- **Production URL**: `https://polls.wwjanado.com`
- **Host**: Cloudflare Pages (or equivalent static Cloudflare hosting).
  This app is plain static files (`index.html` plus `css/` and `js/` ES
  modules) with no build step, so the Cloudflare Pages "no framework /
  static HTML" project type applies directly — there's nothing to build.
- **Do not use Netlify** for future deployments of this project (see
  `CLAUDE.md`). This app previously lived on Netlify; that's being
  replaced by Cloudflare going forward.

## Setting up Cloudflare Pages

1. In the Cloudflare dashboard, create a new Pages project connected to
   this GitHub repository (`JMW05/polling-center`), or deploy directly
   via `wrangler pages deploy` / drag-and-drop if a manual deploy is
   preferred for a given release.
2. Build settings: no build command, output directory `/` (the repo
   root, since `index.html`, `css/` and `js/` live there directly).
3. Attach the custom domain `polls.wwjanado.com` to the Pages project in
   Cloudflare, and point its DNS at Cloudflare per Cloudflare's own
   instructions for that domain.

## Supabase Auth URL configuration — required for this domain

Supabase Auth's Site URL and Redirect URLs govern every Auth-generated
link (signup confirmation, password reset, magic links, future
invitations). These must be set to the production domain, not
`localhost` or a previous domain (e.g. the old Netlify URL):

- **Site URL**: `https://polls.wwjanado.com`
- **Redirect URLs**: include `https://polls.wwjanado.com/**`

Set both in the Supabase Dashboard → Authentication → URL Configuration,
for project `srbiynpchtwtpzcyrhgr`. Do this *before or immediately after*
`polls.wwjanado.com` goes live — Supabase does not follow a domain change
automatically, and a stale Site URL sends real users' confirmation/reset
emails to a dead page.

As defense-in-depth, the sign-up call (`js/admin/auth.js`) also passes
`emailRedirectTo`, computed from `location.origin`/`location.pathname` at
runtime rather than hardcoded — so it always points at whatever domain
the page is actually being served from. This is a backstop, not a
substitute for the dashboard setting above: some Auth-generated emails
(password reset in particular) aren't triggered by a client call with its
own redirect option and are governed by the dashboard Site URL alone.

After the domain is live, verify with one real signup: confirm the
confirmation email link lands on `https://polls.wwjanado.com` and
actually completes sign-in.

## What does *not* change with hosting

Moving hosting providers does not touch the Supabase project, its
migrations, its data, or its RLS/RPC security model — see
`docs/architecture.md`. This is a frontend-only, DNS-and-static-hosting
change; the backend stays exactly as it is.
