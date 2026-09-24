// Frontend equivalence harness. Drives two copies of the frontend identically in
// headless Chromium against a FAKE Supabase client (fake-supabase.js) and compares
// DOM, form state, computed styles, backend calls, downloads, dialogs and
// localStorage after every step:
//   "old" = the frontend as committed at BASE_REF (default: cf15b38, the last
//           commit before the ES-module extraction), served straight from git;
//   "new" = the current working tree.
// See README.md in this directory. Passing this is NOT browser QA against Supabase.
const fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os");
function loadPlaywright() {
  try { return require("playwright"); } catch (e) { /* fall back to a global install */ }
  const globalRoot = cp.execSync("npm root -g").toString().trim();
  return require(path.join(globalRoot, "playwright"));
}
const { chromium } = loadPlaywright();
const ROOT = path.resolve(__dirname, "..", "..");
const BASE_REF = process.env.BASE_REF || "cf15b38";
const OUT_FILE = process.env.OUT_FILE || path.join(os.tmpdir(), "polling-center-frontend-equivalence.json");
const STUB = fs.readFileSync(path.join(__dirname, "fake-supabase.js"), "utf8");
// Serve a file as it existed at BASE_REF (null if it didn't exist there).
function fromGit(p) {
  try { return cp.execFileSync("git", ["-C", ROOT, "show", `${BASE_REF}:${p.replace(/^\//, "")}`], { stdio: ["ignore", "pipe", "ignore"] }); }
  catch (e) { return null; }
}
const CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon" };

async function runVariant(variant) {
  const host = variant + ".test";
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ timezoneId: "America/Chicago", locale: "en-US", acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://" + host });
  const out = { steps: [], log: [], downloads: [], dialogs: [], errors: [], requests: [] };
  await ctx.exposeBinding("__log", (_s, line) => out.log.push(line.replace(/(old|new)\.test/g, "HOST")));
  await ctx.addInitScript(() => {
    let seed = 42; Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    let n = 0; crypto.randomUUID = () => "uuid-" + (++n);
  });
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    out.requests.push(url.host === host ? url.pathname : url.href);
    if (url.href === CDN) return route.fulfill({ contentType: "text/javascript", body: STUB });
    if (url.host !== host) return route.fulfill({ status: 404, body: "" });
    let p = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    if (variant === "old") {
      const body = fromGit(p);
      return body === null ? route.fulfill({ status: 404, body: "" }) : route.fulfill({ contentType: TYPES[path.extname(p)] || "application/octet-stream", body });
    }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ contentType: TYPES[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) });
  });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date("2026-09-20T15:00:00Z"));
  page.on("pageerror", (e) => out.errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") out.errors.push("console: " + m.text()); });
  page.on("dialog", async (d) => { out.dialogs.push(d.message()); await d.accept(); });
  page.on("download", async (d) => { const fp = await d.path(); out.downloads.push({ name: d.suggestedFilename(), body: fs.readFileSync(fp, "utf8") }); });

  const settle = (ms = 250) => page.waitForTimeout(ms);
  async function snap(label) {
    await settle();
    const s = await page.evaluate(() => {
      const els = Array.from(document.body.querySelectorAll("*"));
      const PROPS = Array.from(getComputedStyle(document.body));
      return {
        hash: location.hash,
        title: document.title,
        subtitle: document.getElementById("subtitle").textContent,
        adminBtn: document.getElementById("adminToggleBtn").textContent,
        body: document.body.innerHTML.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ""),
        fields: Array.from(document.querySelectorAll("input,select,textarea,button")).map((e) =>
          [e.tagName, e.type, e.name, e.value, e.checked, e.disabled, e.placeholder, getComputedStyle(e).display].join("|")),
        styles: els.map((e) => { const cs = getComputedStyle(e); return e.tagName + ":" + PROPS.map((p) => cs.getPropertyValue(p)).join(";"); }),
        ls: Object.keys(localStorage).sort().map((k) => k + "=" + localStorage.getItem(k)),
      };
    });
    s.body = s.body.replace(/(old|new)\.test/g, "HOST");
    out.steps.push({ label, ...s });
  }
  const go = async (hash) => { const cur = await page.evaluate(() => location.href).catch(() => ""); const target = `http://${host}/${hash}`; if (cur === target) await page.reload(); else await page.goto(target); await settle(400); };
  const click = async (text, nth = 0) => { await page.locator(`button:text-is("${text}"), a:text-is("${text}"), .tab:text-is("${text}")`).nth(nth).click(); await settle(); };
  const lblInput = (text) => page.locator(`label:text-is("${text}") + input, label:text-is("${text}") + textarea, label:text-is("${text}") + select`).first();

  try {
  // ---------------- PUBLIC ----------------
  await go(""); await snap("public list open");
  await click("Past results"); await snap("public list closed");
  await click("Open polls");
  await page.locator(".org-row select").selectOption("org-2"); await settle(); await snap("public list org-2");
  await page.locator(".org-row select").selectOption("org-1"); await settle();
  await page.locator(".card h3:text-is('Board meeting')").click(); await settle(400); await snap("meeting detail (via card click)");
  await page.locator(".option-row input").nth(1).check(); await click("Submit response"); await snap("meeting submitted");
  await go("#/poll/p-meet"); await snap("meeting revisit (already responded)");

  await go("#/poll/p-choice"); await snap("choice detail");
  await lblInput("Your name").fill("Pat"); await lblInput("Your email").fill("PAT@Example.com");
  await page.locator(".option-row").filter({ hasText: "Write-in" }).locator("input").check(); await settle();
  await page.locator("input[placeholder='Write-in name']").fill("Hall Z");
  await page.locator("textarea").fill("  looks good  ");
  await click("Submit response"); await snap("choice submitted");
  await go("#/poll/p-choice"); await snap("choice revisit (allow change)");

  await go("#/poll/p-elec"); await snap("election detail");
  await click("Cast ballot"); await snap("election no code");
  await page.locator("input[placeholder='Enter the code you were given']").fill("bad");
  await page.locator(".option-row input").first().check();
  await click("Cast ballot"); await snap("election bad code");
  await page.locator("input[placeholder='Enter the code you were given']").fill("  GOOD-CODE  ");
  await click("Cast ballot"); await snap("election cast");
  await go("#/poll/p-elec"); await snap("election revisit");

  await go("#/poll/p-survey"); await snap("survey detail");
  await page.locator(".option-row input").nth(0).check(); await page.locator(".option-row input").nth(1).check(); await page.locator(".option-row input").nth(2).check();
  await click("Submit response"); await snap("survey too many");
  await page.locator(".option-row input").nth(2).uncheck();
  await click("Submit response"); await snap("survey missing yesno");
  await page.locator(".option-row").filter({ hasText: "No" }).locator("input").check();
  await page.locator(".type-choice label").nth(3).click();
  await page.locator("textarea").fill("fine");
  await click("Submit response"); await snap("survey submitted");

  await go("#/poll/p-closed"); await snap("closed detail");
  await go("#/poll/nope"); await snap("missing poll");
  await click("‹ All polls"); await snap("back to list");

  // ---------------- ADMIN AUTH ----------------
  await click("Admin"); await snap("admin auth");
  await click("Create account"); await snap("signup tab");
  await page.locator("input[type=email]").fill("new@x.org"); await page.locator("input[type=password]").fill("pw2");
  await page.locator(".card > button.btn").click(); await settle(); await snap("signup done");
  await click("Sign in");
  await page.locator("input[type=email]").fill("admin@x.org"); await page.locator("input[type=password]").fill("wrong");
  await page.locator(".card > button.btn").click(); await settle(); await snap("signin bad pw");
  await page.locator("input[type=password]").fill("pw");
  await page.locator(".card > button.btn").click(); await settle(500); await snap("dashboard");

  // ---------------- DASHBOARD ----------------
  await click("Draft"); await snap("dashboard drafts");
  await click("Open");
  await page.locator(".card select").first().selectOption("America/New_York"); await click("Save timezone"); await snap("tz saved");
  await page.locator("input[placeholder='e.g. TCABC']").fill("NEWORG"); await click("Add"); await snap("org created");

  // ---------------- POLL MANAGE ----------------
  await go("#/admin/poll/p-meet"); await snap("manage meeting");
  await click("Copy link"); await snap("copied link");
  await page.locator(".card select").last().selectOption("o-m1"); await click("Save final time"); await snap("final saved");
  await click("Export results to CSV"); await settle(500);
  await click("Close poll"); await settle(600); await snap("after close_poll reload");
  await go("#/admin/poll/p-elec"); await snap("manage election");
  await page.locator("textarea").fill("Ann\n\n  Bo  \nCarla"); await click("Generate codes"); await snap("codes generated");
  await click("Download codes as CSV"); await settle(500);
  await go("#/admin/poll/p-survey"); await click("Export results to CSV"); await settle(400); await snap("survey export (hidden results alert)");
  await go("#/admin/poll/p-closed"); await snap("manage closed");
  await go("#/admin/poll/p-draft"); await snap("manage draft");
  await click("Edit"); await settle(700); await snap("after Edit click");
  await go("#/admin/edit/p-draft"); await snap("edit draft form");

  // ---------------- BUILDER: edit ----------------
  await page.locator("form > input[type=text]").first().fill("Draft survey v2");
  await page.locator(".qblock select").first().selectOption("multi_select"); await settle(); await snap("edit: q type changed");
  await click("Preview"); await snap("edit: preview");
  await click("‹ Back to edit"); await snap("edit: back");
  await click("Save as draft"); await settle(700); await snap("edit: saved -> manage");

  // ---------------- BUILDER: new, each type ----------------
  await go("#/admin/new"); await snap("new: meeting default");
  for (const t of ["Choice / decision", "Election", "Survey / feedback", "Meeting availability"]) {
    await page.locator(".type-choice label").filter({ hasText: t }).click(); await settle(); await snap("new: type " + t);
  }
  // choice
  await page.locator(".type-choice label").filter({ hasText: "Choice / decision" }).click(); await settle();
  await page.locator("form > input[type=text]").first().fill("Lunch?");
  await page.locator("form textarea").first().fill("Pick one");
  await page.locator(".option-edit-row input[type=text]").nth(0).fill("Pizza");
  await page.locator(".option-edit-row input[type=text]").nth(1).fill("Tacos");
  await click("+ Add option"); await page.locator(".option-edit-row input[type=text]").nth(2).fill("Salad");
  await page.locator("input[type=number]").first().fill("2"); await settle();
  await page.locator(".checkline").filter({ hasText: "Allow write-in" }).locator("input").check(); await settle();
  await page.locator(".checkline").filter({ hasText: "Allow an optional comment" }).locator("input").check(); await settle();
  await page.locator("select").nth(0).selectOption("identified"); await settle();
  await page.locator(".qblock-head input").nth(0).fill("Lunch?");
  await snap("new choice filled");
  await page.locator("#secretCk").check(); await settle(); await snap("new choice secret");
  await page.locator("#secretCk").uncheck(); await settle();
  await page.locator(".option-edit-row .rm").nth(2).click(); await settle(); await snap("new choice removed option");
  await settle(1000); await snap("new choice autosaved");
  await click("Preview"); await snap("new choice preview");
  await click("Looks good — Save & publish"); await settle(700); await snap("new choice published");

  // meeting + draft recovery
  await go("#/admin/new"); await snap("new again (no recovery after success)");
  await page.locator("form > input[type=text]").first().fill("Q4 meeting");
  await page.locator(".slot-row input").nth(0).fill("2026-11-03T09:30"); await page.locator(".slot-row input").nth(1).fill("2026-11-03T10:30");
  await page.locator(".slot-row input").nth(2).fill("2026-11-04T14:00");
  await click("+ Add time slot"); await page.locator(".slot-row input").nth(4).fill("2026-11-05T08:00");
  await page.locator("select").nth(1).selectOption("America/Denver"); await settle();
  await page.locator("input[type=datetime-local]").nth(1).fill("2026-11-10T17:00");
  await settle(1000); await snap("meeting autosaved");
  await page.reload(); await settle(500); await snap("reload -> recovery prompt");
  await click("Restore draft"); await snap("restored");
  await page.reload(); await settle(500); await click("Discard"); await snap("discarded");
  await page.reload(); await settle(500); await snap("after discard reload");

  // survey + auth-expiry path
  await page.locator(".type-choice label").filter({ hasText: "Survey / feedback" }).click(); await settle();
  await page.locator("form > input[type=text]").first().fill("Pulse");
  await snap("survey type after meeting (questions carried over)");
  await page.locator(".qblock select").nth(0).selectOption("single_select"); await settle();
  await page.locator(".qblock-head input").nth(0).fill("Colour?");
  await page.locator(".option-edit-row input[type=text]").nth(0).fill("Red"); await page.locator(".option-edit-row input[type=text]").nth(1).fill("Blue");
  await click("+ Add another question"); await page.locator(".qblock select").nth(1).selectOption("rating"); await settle();
  await page.locator(".qblock-head input").nth(1).fill("Score");
  await click("+ Add another question"); await page.locator(".qblock select").nth(2).selectOption("text"); await settle();
  await page.locator(".qblock-head input").nth(2).fill("Notes");
  await page.locator(".qblock").nth(2).locator(".checkline input").uncheck();
  await click("+ Add another question"); await page.locator(".qblock select").nth(3).selectOption("yesno"); await settle();
  await page.locator(".qblock-head input").nth(3).fill("OK?");
  await click("+ Add another question"); await page.locator(".qblock .rmq").nth(4).click(); await settle();
  await snap("survey built");
  await page.evaluate(() => localStorage.setItem("stub_fail_save", "val"));
  await click("Save as draft"); await settle(500); await snap("survey save validation error");
  await page.evaluate(() => localStorage.setItem("stub_fail_save", "auth"));
  await click("Save & publish"); await settle(700); await snap("survey auth expiry");
  await page.locator("input[type=email]").fill("admin@x.org"); await page.locator("input[type=password]").fill("pw");
  await page.locator(".card > button.btn").click(); await settle(600); await snap("re-signin -> recovery offered");
  await click("Restore draft"); await snap("survey restored after re-signin");

  // election
  await go("#/admin/new"); await click("Discard");
  await page.locator(".type-choice label").filter({ hasText: "Election" }).click(); await settle();
  await page.locator("form > input[type=text]").first().fill("Board election");
  await page.locator(".qblock-head input").nth(0).fill("Chair");
  await page.locator(".option-edit-row input[type=text]").nth(0).fill("Ann"); await page.locator(".option-edit-row input[type=text]").nth(1).fill("Bo");
  await page.locator(".checkline").filter({ hasText: "Allow abstain" }).locator("input").check(); await settle();
  await click("+ Add another race/question"); await snap("election built");
  await click("Save & publish"); await snap("election missing close / race");
  await page.locator(".qblock-head input").nth(1).fill("Treasurer");
  await page.locator(".qblock").nth(1).locator(".option-edit-row input[type=text]").nth(0).fill("Cy");
  await page.locator(".qblock").nth(1).locator(".option-edit-row input[type=text]").nth(1).fill("Di");
  await page.locator("input[type=datetime-local]").nth(1).fill("2026-12-01T18:00");
  await click("Preview"); await snap("election preview");
  await click("Looks good — Save & publish"); await settle(700); await snap("election published");

  // unknown route + sign out
  await go("#/admin/bogus"); await snap("admin bogus route -> list");
  await go("#/admin"); await click("Sign out"); await settle(500); await snap("signed out");

  } catch (e) { out.fatal = String(e).split("\n")[0]; out.fatalBody = await page.evaluate(() => document.getElementById("app").innerText).catch(() => ""); out.fatalHash = await page.evaluate(() => location.hash).catch(()=>""); }
  await browser.close();
  return out;
}

(async () => {
  cp.execFileSync("git", ["-C", ROOT, "rev-parse", "--verify", BASE_REF + "^{commit}"], { stdio: "ignore" });
  console.log(`comparing BASE_REF=${BASE_REF} ("old") against the working tree ("new")`);
  const [a, b] = await Promise.all([runVariant("old"), runVariant("new")]);
  for (const v of [a, b]) if (v.fatal) { console.log("FATAL", v.fatal, v.fatalHash, "\n", v.fatalBody.slice(0, 800)); }
  let diffs = (a.fatal || b.fatal) ? 1 : 0;
  const report = [];
  const n = Math.max(a.steps.length, b.steps.length);
  for (let i = 0; i < n; i++) {
    const x = a.steps[i], y = b.steps[i];
    if (!x || !y) { report.push("step count mismatch at " + i); diffs++; continue; }
    for (const k of ["label", "hash", "title", "subtitle", "adminBtn", "body", "fields", "ls"]) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) { diffs++; report.push(`[${x.label}] ${k} differs\n  old: ${JSON.stringify(x[k]).slice(0, 600)}\n  new: ${JSON.stringify(y[k]).slice(0, 600)}`); }
    }
    if (x.styles.length !== y.styles.length) { diffs++; report.push(`[${x.label}] element count ${x.styles.length} vs ${y.styles.length}`); }
    else x.styles.forEach((s, j) => { if (s !== y.styles[j]) { diffs++; report.push(`[${x.label}] computed style differs on element #${j} ${s.split(":")[0]}`); } });
  }
  // The app's navigate(...)+location.reload() pattern (save/publish/lifecycle) lets the
  // hashchange render start a few READ-ONLY calls before the reload unloads the page;
  // how many is pure timing. Drop only read-only calls that immediately precede a page
  // load (createClient) so that race doesn't mask/masquerade as a real difference.
  const READ = /^(from:|rpc:get_|rpc:list_|rpc:is_platform_owner|auth:getSession)/;
  function strip(log) {
    const outl = []; let dropped = 0;
    for (const l of log) {
      const o = JSON.parse(l);
      if (o.kind === "init") { while (outl.length && READ.test(JSON.parse(outl[outl.length - 1]).kind + ":" + JSON.parse(outl[outl.length - 1]).name) && outl.length && !/"kind":"init"/.test(outl[outl.length - 1])) { outl.pop(); dropped++; } }
      outl.push(l);
    }
    return { outl, dropped };
  }
  const sa = strip(a.log), sb2 = strip(b.log);
  console.log(`pre-reload read-only calls dropped: old=${sa.dropped} new=${sb2.dropped}; raw calls old=${a.log.length} new=${b.log.length}`);
  a.log = sa.outl; b.log = sb2.outl;
  for (const k of ["log", "downloads", "dialogs", "errors"]) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { diffs++; report.push(`${k} differ:\n old ${JSON.stringify(a[k]).slice(0, 1500)}\n new ${JSON.stringify(b[k]).slice(0, 1500)}`); }
  }
  const rpcNames = [...new Set(a.log.map((l) => { const o = JSON.parse(l); return o.kind + ":" + o.name; }))].sort();
  console.log(report.join("\n"));
  console.log(`steps=${a.steps.length} elements-compared=${a.steps.reduce((s, x) => s + x.styles.length, 0)} backend-calls=${a.log.length} downloads=${a.downloads.length} dialogs=${a.dialogs.length}`);
  console.log("backend calls exercised:", rpcNames.join(", "));
  console.log("page errors old:", a.errors.length, "new:", b.errors.length, b.errors.slice(0, 5));
  console.log("new-variant same-origin requests:", [...new Set(b.requests.filter((r) => r.startsWith("/")))].sort().join(" "));
  fs.writeFileSync(OUT_FILE, JSON.stringify({ a, b }, null, 1));
  console.log("full step-by-step capture written to", OUT_FILE);
  console.log(diffs === 0 ? "RESULT: IDENTICAL" : `RESULT: ${diffs} DIFFERENCES`);
  process.exit(diffs === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
