// Polling Center bootstrap: router mount, auth listener, header nav, main
// render (route table) and init. Module order of side effects matches the
// former inline <script>: hashchange listener, auth listener, header
// listeners, then init().
import { sb } from "./supabase-client.js";
import { state, refreshAdminContext, hasAnyAdminRole, loadOrgs } from "./state.js";
import { parseHash, navigate, render, setRenderer, mountRouter } from "./router.js";
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
  state.session = session;
  // IMPORTANT: Supabase fires this callback on every auth event,
  // including TOKEN_REFRESHED -- which happens automatically and
  // silently in the background, well before real session expiry, as
  // part of normal token upkeep. It does NOT mean the user's session
  // expired or that anything about their identity changed. Calling the
  // full render() here on every TOKEN_REFRESHED used to wipe out
  // whatever the admin had in progress (e.g. an unsaved poll-builder
  // form), because render() tears down and rebuilds #app from scratch.
  // Only actual identity transitions should trigger a re-render.
  if (evt === "SIGNED_IN" || evt === "SIGNED_OUT" || evt === "USER_UPDATED") {
    refreshAdminContext().then(render);
  }
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
async function renderApp() {
  updateAdminBtn();
  app.innerHTML = "";
  try {
    if (!state.orgs.length) await loadOrgs();
  } catch (e) {
    app.appendChild(msgBox("error", "Could not load organizations: " + (e.message || e)));
    return;
  }

  var route = state.route;
  if (route.view === "pollDetail") {
    await renderPublicPollDetail(app, route.pollId);
  } else if (route.view === "admin" || route.view === "adminNew" || route.view === "adminPoll" || route.view === "adminEdit") {
    if (!state.session) {
      var sres = await sb.auth.getSession();
      state.session = sres.data.session;
      if (state.session) await refreshAdminContext();
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

(async function init() {
  var sres = await sb.auth.getSession();
  state.session = sres.data.session;
  if (state.session) await refreshAdminContext();
  state.route = parseHash();
  render();
})();
