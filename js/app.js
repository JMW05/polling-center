// Polling Center bootstrap: router mount, auth listener, header nav, main
// render (route table) and init. Module order of side effects matches the
// former inline <script>: hashchange listener, auth listener, header
// listeners, then init().
import { sb } from "./supabase-client.js";
import { state, refreshAdminContext, hasAnyAdminRole, ensureOrgsLoaded } from "./state.js";
import { parseHash, navigate, render, setRenderer, mountRouter, beginRender, isStaleRender } from "./router.js";
import { applySession, completeBoot, userIdOf } from "./session.js";
import { msgBox } from "./shared/helpers.js";
import { renderPublicList } from "./public/poll-list.js";
import { renderPublicPollDetail } from "./public/poll-response.js";
import { renderAdminAuth, renderAdminBootstrap } from "./admin/auth.js";
import { renderAdmin } from "./admin/dashboard.js";
import { renderAdminPoll } from "./admin/poll-manage.js";
import { renderPollForm } from "./admin/poll-builder.js";

mountRouter();

// ============================================================
// AUTH
// ============================================================
sb.auth.onAuthStateChange(function (evt, session) {
  // IMPORTANT: Supabase fires this callback on every auth event --
  // INITIAL_SESSION, TOKEN_REFRESHED, and also SIGNED_IN for a session it
  // merely restored from storage (at startup and on every tab refocus).
  // None of those mean the user changed, and render() tears down and
  // rebuilds #app from scratch (wiping e.g. an unsaved poll-builder form).
  // applySession() (session.js) records the session and re-renders only
  // on a real identity change, and never during startup, which init()
  // owns.
  applySession(session);
});

// ============================================================
// HEADER / NAV
// ============================================================
var app = document.getElementById("app");
var adminToggleBtn = document.getElementById("adminToggleBtn");
document.getElementById("titleHome").addEventListener("click", function () { navigate("#/"); });

function updateAdminBtn() {
  if (state.session) {
    adminToggleBtn.textContent = "Sign out";
  } else {
    adminToggleBtn.textContent = "Admin";
  }
}
adminToggleBtn.addEventListener("click", async function () {
  if (state.session) {
    await sb.auth.signOut();
    state.session = null; state.isPlatformOwner = false; state.adminOrgIds = null; state.bootstrapAttempted = false;
    navigate("#/");
  } else {
    navigate("#/admin");
  }
});

// ============================================================
// MAIN RENDER
// ============================================================
// Only the newest renderApp() call may touch #app: each one starts a new
// render generation and stops after any await once it's been superseded.
async function renderApp() {
  var gen = beginRender();
  updateAdminBtn();
  app.innerHTML = "";
  try {
    if (!state.orgs.length) await ensureOrgsLoaded();
  } catch (e) {
    if (isStaleRender(gen)) return;
    app.appendChild(msgBox("error", "Could not load organizations: " + (e.message || e)));
    return;
  }
  if (isStaleRender(gen)) return;

  var route = state.route;
  if (route.view === "pollDetail") {
    await renderPublicPollDetail(app, route.pollId);
  } else if (route.view === "admin" || route.view === "adminNew" || route.view === "adminPoll" || route.view === "adminEdit") {
    if (!state.session) {
      var sres = await sb.auth.getSession();
      if (isStaleRender(gen)) return;
      state.session = sres.data.session;
      if (state.session) await refreshAdminContext();
      if (isStaleRender(gen)) return;
    }
    if (!state.session) { renderAdminAuth(app); return; }
    if (!hasAnyAdminRole()) { await renderAdminBootstrap(app); return; }
    if (route.view === "adminNew") await renderPollForm(app, null);
    else if (route.view === "adminEdit") await renderPollForm(app, route.pollId);
    else if (route.view === "adminPoll") await renderAdminPoll(app, route.pollId);
    else await renderAdmin(app);
  } else {
    await renderPublicList(app);
  }
}
setRenderer(renderApp);

// init() is the single owner of startup: it resolves the session, loads
// admin context for it, and does the first render. Auth events that
// arrive meanwhile only update state.session (see session.js); if one
// changed the user while admin context was loading, reload it for the
// user we'll actually render.
(async function init() {
  var sres = await sb.auth.getSession();
  state.session = sres.data.session;
  var id;
  do {
    id = userIdOf(state.session);
    if (state.session) await refreshAdminContext();
    else { state.isPlatformOwner = false; state.adminOrgIds = null; }
  } while (userIdOf(state.session) !== id);
  completeBoot();
  state.route = parseHash();
  render();
})();
