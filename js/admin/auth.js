import { sb } from "../supabase-client.js";
import { state, refreshAdminContext } from "../state.js";
import { render } from "../router.js";
import { subtitle, el, msgBox } from "../shared/helpers.js";

// ============================================================
// ADMIN: auth screens
// ============================================================
export function renderAdminAuth(container) {
  subtitle.textContent = "Admin sign-in";
  var card = el("div", "card");
  var tabbar = el("div", "tabbar");
  var mode = "signin";
  var signinTab = el("button", "tab active", "Sign in");
  var signupTab = el("button", "tab", "Create account");
  tabbar.appendChild(signinTab); tabbar.appendChild(signupTab);
  card.appendChild(tabbar);

  var emailLabel = el("label", null, "Email");
  card.appendChild(emailLabel);
  var emailInput = document.createElement("input"); emailInput.type = "email"; emailInput.autocomplete = "username";
  card.appendChild(emailInput);
  card.appendChild(el("label", null, "Password"));
  var pwInput = document.createElement("input"); pwInput.type = "password"; pwInput.autocomplete = "current-password";
  card.appendChild(pwInput);

  var msgHolder = el("div", null); msgHolder.style.marginTop = "10px";
  card.appendChild(msgHolder);

  var btn = el("button", "btn", "Sign in"); btn.style.marginTop = "14px";
  card.appendChild(btn);

  function setMode(m) {
    mode = m;
    signinTab.className = "tab" + (m === "signin" ? " active" : "");
    signupTab.className = "tab" + (m === "signup" ? " active" : "");
    btn.textContent = m === "signin" ? "Sign in" : "Create account";
    pwInput.autocomplete = m === "signin" ? "current-password" : "new-password";
    msgHolder.innerHTML = "";
  }
  signinTab.addEventListener("click", function () { setMode("signin"); });
  signupTab.addEventListener("click", function () { setMode("signup"); });

  btn.addEventListener("click", async function () {
    msgHolder.innerHTML = "";
    var email = emailInput.value.trim(), pw = pwInput.value;
    if (!email || !pw) { msgHolder.appendChild(msgBox("error", "Enter an email and password.")); return; }
    btn.disabled = true;
    try {
      if (mode === "signin") {
        var r = await sb.auth.signInWithPassword({ email: email, password: pw });
        if (r.error) throw r.error;
        state.session = r.data.session;
        await refreshAdminContext();
        // Do NOT force-navigate to #/admin here. If the admin was
        // bounced to sign-in mid-task (e.g. re-authenticating after a
        // session interruption while editing a poll), state.route is
        // already pointing at wherever they were trying to go
        // (adminNew/adminEdit/etc); just re-render in place so any
        // pending draft-recovery flow on that route can pick up.
        render();
      } else {
        var r2 = await sb.auth.signUp({
          email: email,
          password: pw,
          options: { emailRedirectTo: location.origin + location.pathname + "#/admin" }
        });
        if (r2.error) throw r2.error;
        if (r2.data.session) {
          state.session = r2.data.session;
          await refreshAdminContext();
          render();
        } else {
          msgHolder.innerHTML = "";
          msgHolder.appendChild(msgBox("success", "Account created. Check your email to confirm it, then sign in."));
        }
      }
    } catch (err) {
      msgHolder.innerHTML = "";
      msgHolder.appendChild(msgBox("error", err.message || String(err)));
    } finally {
      btn.disabled = false;
    }
  });

  container.appendChild(card);
}

// No general-purpose "claim admin" affordance is shown here — that was
// the race-condition risk. Any signed-in user who lands here silently
// gets ONE attempt at bootstrap_platform_owner(), which the database
// (migration 0008) now only ever allows to succeed for one specific,
// pre-authorized account. Everyone else — which, after that first real
// owner exists, is everyone — just sees a neutral message and no button.
export async function renderAdminBootstrap(container) {
  subtitle.textContent = "Admin access";
  var card = el("div", "card");
  card.appendChild(el("h3", null, "You don't have admin access yet"));
  var msgHolder = el("div", null); msgHolder.style.marginTop = "10px";
  card.appendChild(msgHolder);
  container.appendChild(card);

  if (!state.bootstrapAttempted) {
    state.bootstrapAttempted = true;
    try {
      var r = await sb.rpc("bootstrap_platform_owner");
      if (!r.error) {
        await refreshAdminContext();
        render();
        return;
      }
    } catch (e) { /* not authorized / already bootstrapped — fall through */ }
  }
  msgHolder.innerHTML = "";
  msgHolder.appendChild(msgBox("info", "Ask an existing administrator to add your account to an organization."));
}
