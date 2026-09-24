// Startup / auth-event regression test.
//
// Unlike run.js (old-vs-new equivalence against a hand-written fake client),
// this loads the REAL supabase-js UMD build (pinned devDependency) so the
// library's own auth event sequence is exercised: SIGNED_IN for a session
// restored from localStorage at startup, SIGNED_IN again on every
// hidden -> visible tab change, SIGNED_OUT, and SIGNED_IN on a password
// sign-in. Only Supabase's HTTP endpoints are faked (fixed latency), so
// nothing ever reaches the real project.
//
// It asserts: one visible UI (never two), one organizations fetch, one
// admin-context sequence per real identity, no rebuild and no extra
// requests on a same-user SIGNED_IN, unsaved builder input surviving a tab
// switch, and correct single renders on sign-out / sign-in / user switch.
//
//   node tests/frontend-equivalence/auth-startup.js            # working tree
//   BASE_REF=6330a45 node tests/frontend-equivalence/auth-startup.js
//                     # same checks against an older commit (shows the bug)
const fs = require("fs"), path = require("path"), cp = require("child_process");
function req(name) {
  try { return require(name); } catch (e) { /* fall back to a global install */ }
  return require(path.join(cp.execSync("npm root -g").toString().trim(), name));
}
const { chromium } = req("playwright");
const ROOT = path.resolve(__dirname, "..", "..");
const BASE_REF = process.env.BASE_REF || null; // null = working tree
const SBJS = fs.readFileSync(require.resolve("@supabase/supabase-js/dist/umd/supabase.js", { paths: [__dirname] }));
const SBJS_VERSION = require(require.resolve("@supabase/supabase-js/package.json", { paths: [__dirname] })).version;
const CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
const SB = "https://srbiynpchtwtpzcyrhgr.supabase.co";
const LATENCY_MS = 80;

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const USERS = {
  "admin@x.org": { id: "user-a", email: "admin@x.org", owner: true },
  "second@x.org": { id: "user-b", email: "second@x.org", owner: false },
};
function sessionFor(u) {
  const now = Math.floor(Date.now() / 1000);
  const user = { id: u.id, aud: "authenticated", role: "authenticated", email: u.email, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  const jwt = b64u({ alg: "HS256", typ: "JWT" }) + "." + b64u({ sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", exp: now + 3600, iat: now, session_id: "s-" + u.id }) + ".sig";
  return { access_token: jwt, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: "refresh-" + u.id, user };
}
const userFromAuthHeader = (h) => {
  try { const sub = JSON.parse(Buffer.from((h || "").replace(/^Bearer /, "").split(".")[1], "base64url").toString()).sub; return Object.values(USERS).find((u) => u.id === sub) || null; }
  catch (e) { return null; }
};

function serveApp(p) {
  if (BASE_REF) {
    try { return cp.execFileSync("git", ["-C", ROOT, "show", `${BASE_REF}:${p.slice(1)}`], { stdio: ["ignore", "pipe", "ignore"] }); }
    catch (e) { return null; }
  }
  const f = path.join(ROOT, p);
  return f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : null;
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

async function newSession(browser, { storedUser } = {}) {
  const ctx = await browser.newContext({ timezoneId: "America/Chicago" });
  const net = []; // ordered log of Supabase calls
  await ctx.route("**/*", async (route) => {
    const r = route.request(), u = new URL(r.url());
    if (u.href === CDN) return route.fulfill({ contentType: "text/javascript", body: SBJS });
    if (u.origin === SB) {
      if (r.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
      let body = null; try { body = r.postDataJSON(); } catch (e) {}
      const name = u.pathname.replace(/^\/(rest|auth)\/v1\/(rpc\/)?/, "") + (u.pathname === "/auth/v1/token" ? "?" + u.searchParams.get("grant_type") : "");
      net.push({ name, body, user: userFromAuthHeader(r.headers()["authorization"]) });
      await new Promise((res) => setTimeout(res, LATENCY_MS));
      const J = (o, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(o) });
      if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "password") {
        const usr = USERS[body && body.email];
        return usr && body.password === "pw" ? J(sessionFor(usr)) : J({ error: "invalid_grant", error_description: "Invalid login credentials" }, 400);
      }
      if (u.pathname === "/auth/v1/token") return J(sessionFor(USERS["admin@x.org"]));
      if (u.pathname === "/auth/v1/logout") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" }, body: "" });
      if (u.pathname === "/auth/v1/user") { const usr = userFromAuthHeader(r.headers()["authorization"]); return usr ? J(sessionFor(usr).user) : J({ msg: "no user" }, 401); }
      if (name === "is_platform_owner") { const usr = Object.values(USERS).find((x) => x.id === (body && body.p_uid)); return J(!!(usr && usr.owner)); }
      if (name === "org_admins") return J([{ org_id: "org-1" }]);
      if (name === "organizations") return J([{ id: "org-1", name: "TCABC", default_timezone: "America/Chicago" }]);
      if (name === "list_public_polls" || name === "polls") return J([]);
      if (name === "get_public_poll_detail" && body && body.p_poll_id === "p1")
        return J({ id: "p1", title: "Slow poll title", description: "", poll_type: "choice", status: "closed", access_mode: "link", anonymous: false, timezone: "UTC", questions: [] });
      if (name === "get_poll_results") return J({ visible: false, reason: "not_yet_visible" });
      return J(null);
    }
    if (u.host !== "app.test") return route.fulfill({ status: 404, body: "" });
    const p = u.pathname === "/" ? "/index.html" : decodeURIComponent(u.pathname);
    const body = serveApp(p);
    return body === null ? route.fulfill({ status: 404, body: "" }) : route.fulfill({ contentType: TYPES[path.extname(p)] || "application/octet-stream", body });
  });
  // Observe (never alter) the app's own client: log every auth event it emits,
  // and count how many times #app's content is torn down and rebuilt.
  await ctx.addInitScript(({ stored }) => {
    window.__authEvents = []; window.__appRebuilds = 0;
    let real;
    Object.defineProperty(window, "supabase", { configurable: true, get: () => real, set: (v) => {
      const create = v.createClient;
      v.createClient = function () {
        const client = create.apply(this, arguments);
        client.auth.onAuthStateChange((evt, s) => window.__authEvents.push(evt + ":" + ((s && s.user && s.user.id) || "none")));
        return client;
      };
      real = v;
    } });
    document.addEventListener("DOMContentLoaded", () => {
      const app = document.getElementById("app");
      new MutationObserver((recs) => { if (recs.some((r) => r.removedNodes.length)) window.__appRebuilds++; }).observe(app, { childList: true });
    });
    if (stored && !sessionStorage.getItem("__seeded")) {
      localStorage.setItem("sb-srbiynpchtwtpzcyrhgr-auth-token", JSON.stringify(stored));
      sessionStorage.setItem("__seeded", "1");
    }
  }, { stored: storedUser ? sessionFor(USERS[storedUser]) : null });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, net, errors };
}

const settle = (page, ms = 1200) => page.waitForTimeout(ms);
async function ui(page) {
  return page.evaluate(() => {
    const app = document.getElementById("app");
    const txt = app.innerHTML;
    return {
      orgSelectors: app.querySelectorAll(".org-row").length,
      tabbars: app.querySelectorAll(".tabbar").length,
      noOpenPolls: (txt.match(/No open polls right now\./g) || []).length,
      builderForms: app.querySelectorAll("form .type-choice").length,
      dashboards: (txt.match(/\+ New poll for /g) || []).length,
      authCards: app.querySelectorAll("input[type=password]").length,
      adminBtn: document.getElementById("adminToggleBtn").textContent,
      authEvents: window.__authEvents.slice(),
      rebuilds: window.__appRebuilds,
    };
  });
}
const count = (net, name, from = 0) => net.slice(from).filter((c) => c.name === name).length;
async function tabHideShow(page) {
  await page.evaluate(() => {
    let v = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
    window.dispatchEvent(new Event("visibilitychange"));
    v = "visible";
    window.dispatchEvent(new Event("visibilitychange"));
  });
}

const results = [];
function check(scenario, label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ scenario, label, ok, actual, expected });
}

(async () => {
  const browser = await chromium.launch();
  console.log(`auth-startup: supabase-js ${SBJS_VERSION} (real), app from ${BASE_REF ? "git " + BASE_REF : "working tree"}`);

  // 1. Signed-out first visit (baseline).
  {
    const S = "signed-out first load";
    const { ctx, page, net, errors } = await newSession(browser);
    await page.goto("http://app.test/"); await settle(page);
    const u = await ui(page);
    check(S, "org selectors visible", u.orgSelectors, 1);
    check(S, "'No open polls' messages", u.noOpenPolls, 1);
    check(S, "organizations requests", count(net, "organizations"), 1);
    check(S, "list_public_polls requests", count(net, "list_public_polls"), 1);
    check(S, "is_platform_owner requests", count(net, "is_platform_owner"), 0);
    check(S, "page errors", errors, []);
    await ctx.close();
  }

  // 2-4. Restored signed-in session: startup, repeated same-user SIGNED_IN (tab refocus), sign-out, sign back in, switch user.
  {
    const S = "restored session";
    const { ctx, page, net, errors } = await newSession(browser, { storedUser: "admin@x.org" });
    await page.goto("http://app.test/"); await settle(page);
    let u = await ui(page);
    check(S, "startup auth events include restored SIGNED_IN", u.authEvents.includes("SIGNED_IN:user-a"), true);
    check(S, "org selectors visible", u.orgSelectors, 1);
    check(S, "tab bars visible", u.tabbars, 1);
    check(S, "'No open polls' messages", u.noOpenPolls, 1);
    check(S, "organizations requests", count(net, "organizations"), 1);
    check(S, "is_platform_owner requests", count(net, "is_platform_owner"), 1);
    check(S, "org_admins requests", count(net, "org_admins"), 1);
    check(S, "list_public_polls requests", count(net, "list_public_polls"), 1);
    check(S, "#app rebuilds after first build", u.rebuilds, 0);

    const S2 = "tab hide/show, same user (public list)";
    let mark = net.length, evBefore = u.authEvents.length;
    await tabHideShow(page); await settle(page);
    u = await ui(page);
    check(S2, "supabase-js emitted another SIGNED_IN for the same user", u.authEvents.slice(evBefore).includes("SIGNED_IN:user-a"), true);
    check(S2, "#app rebuilds", u.rebuilds, 0);
    check(S2, "new app requests (is_platform_owner/org_admins/organizations/list_public_polls)",
      ["is_platform_owner", "org_admins", "organizations", "list_public_polls"].map((n) => count(net, n, mark)), [0, 0, 0, 0]);
    check(S2, "org selectors visible", u.orgSelectors, 1);

    const S3 = "sign out (header button, from admin dashboard)";
    await page.evaluate(() => { location.hash = "#/admin"; }); await settle(page);
    u = await ui(page);
    check(S3, "dashboard visible before sign-out", u.dashboards, 1);
    mark = net.length; evBefore = u.authEvents.length;
    await page.click("#adminToggleBtn"); await settle(page);
    u = await ui(page);
    check(S3, "auth events", u.authEvents.slice(evBefore), ["SIGNED_OUT:none"]);
    check(S3, "header button", u.adminBtn, "Admin");
    check(S3, "public list shown once", [u.orgSelectors, u.noOpenPolls, u.dashboards], [1, 1, 0]);
    check(S3, "organizations re-fetched", count(net, "organizations", mark), 0);

    const S4 = "sign in again as the same user";
    await page.click("#adminToggleBtn"); await settle(page, 600);
    await page.fill("input[type=email]", "admin@x.org"); await page.fill("input[type=password]", "pw");
    mark = net.length; evBefore = (await ui(page)).authEvents.length;
    await page.click(".card > button.btn"); await settle(page);
    u = await ui(page);
    check(S4, "auth events", u.authEvents.slice(evBefore), ["SIGNED_IN:user-a"]);
    check(S4, "dashboard shown once", [u.dashboards, u.authCards], [1, 0]);
    check(S4, "is_platform_owner / org_admins / dashboard polls requests", ["is_platform_owner", "org_admins", "polls"].map((n) => count(net, n, mark)), [1, 1, 1]);

    const S5 = "sign in as a different user";
    await page.click("#adminToggleBtn"); await settle(page);
    await page.click("#adminToggleBtn"); await settle(page, 600);
    await page.fill("input[type=email]", "second@x.org"); await page.fill("input[type=password]", "pw");
    mark = net.length; evBefore = (await ui(page)).authEvents.length;
    await page.click(".card > button.btn"); await settle(page);
    u = await ui(page);
    check(S5, "auth events", u.authEvents.slice(evBefore), ["SIGNED_IN:user-b"]);
    check(S5, "admin context loaded for user B exactly once", net.slice(mark).filter((c) => c.name === "is_platform_owner").map((c) => c.body && c.body.p_uid), ["user-b"]);
    check(S5, "dashboard shown once", [u.dashboards, u.authCards], [1, 0]);
    check(S, "page errors", errors, []);
    await ctx.close();
  }

  // 5. Poll builder: a keystroke typed right before a tab switch survives the same-user SIGNED_IN.
  {
    const S = "builder keystroke + tab switch";
    const { ctx, page, net, errors } = await newSession(browser, { storedUser: "admin@x.org" });
    await page.goto("http://app.test/#/admin/new"); await settle(page);
    let u = await ui(page);
    check(S, "builder forms visible on restored-session load", u.builderForms, 1);
    check(S, "admin-context requests at startup", ["is_platform_owner", "org_admins", "organizations"].map((n) => count(net, n)), [1, 1, 1]);
    const evBefore = u.authEvents.length;
    await page.locator("form > input[type=text]").first().fill("Typed just before switching tabs");
    await tabHideShow(page); // immediately: well inside the 800 ms local-draft debounce
    await settle(page);
    u = await ui(page);
    check(S, "supabase-js emitted another SIGNED_IN for the same user", u.authEvents.slice(evBefore).includes("SIGNED_IN:user-a"), true);
    check(S, "#app rebuilds", u.rebuilds, 0);
    check(S, "builder forms visible", u.builderForms, 1);
    check(S, "title field still holds the typed value", await page.locator("form > input[type=text]").first().inputValue(), "Typed just before switching tabs");
    check(S, "page errors", errors, []);
    await ctx.close();
  }

  // 6. Overlapping renders that are NOT auth-related.
  {
    const S = "overlapping renders";
    // (a) A second render starts while the first is still waiting on the
    //     initial organizations fetch (e.g. a link click during boot).
    const { ctx, page, net, errors } = await newSession(browser);
    await page.goto("http://app.test/", { waitUntil: "commit" });
    for (let i = 0; i < 200 && count(net, "organizations") === 0; i++) await page.waitForTimeout(5);
    // The organizations request is now in flight (LATENCY_MS), so the first render is waiting on it.
    await page.evaluate(() => { location.hash = "#/again"; });
    await settle(page);
    let u = await ui(page);
    check(S, "(a) render during the in-flight org fetch: one public list", [u.orgSelectors, u.tabbars, u.noOpenPolls], [1, 1, 1]);
    check(S, "(a) organizations requests", count(net, "organizations"), 1);

    // (b) Leave a poll page before its data arrives: the superseded poll
    //     render must not overwrite the list page's header afterwards.
    await page.evaluate(() => { location.hash = "#/poll/p1"; });
    await page.waitForTimeout(10);
    await page.evaluate(() => { location.hash = "#/"; });
    await settle(page);
    u = await ui(page);
    const subtitle = await page.evaluate(() => document.getElementById("subtitle").textContent);
    check(S, "(b) header subtitle belongs to the page actually shown", subtitle, "Vote on meetings, decisions & elections");
    check(S, "(b) one public list, no poll content", [u.orgSelectors, await page.evaluate(() => /Slow poll title/.test(document.getElementById("app").innerText))], [1, false]);
    check(S, "page errors", errors, []);
    await ctx.close();
  }

  await browser.close();
  let failed = 0, scen = null;
  for (const r of results) {
    if (r.scenario !== scen) { scen = r.scenario; console.log("\n" + scen); }
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}` + (r.ok ? `: ${JSON.stringify(r.actual)}` : `: got ${JSON.stringify(r.actual)}, expected ${JSON.stringify(r.expected)}`));
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
