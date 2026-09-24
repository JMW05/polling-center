import { state, refreshAdminContext, resetOrgsInFlight } from "./state.js";
import { render } from "./router.js";

// ============================================================
// AUTH IDENTITY
//
// supabase-js emits SIGNED_IN not only on a real sign-in but also when it
// restores a stored session at startup and every time the tab becomes
// visible again (auth-js _recoverAndRefresh). Treating each SIGNED_IN as
// "identity changed" built the UI twice on signed-in page loads and
// rebuilt the poll builder (dropping unsaved input) on tab refocus.
//
// Rules:
// - init() (app.js) owns initial session resolution, the admin-context
//   refresh and the first render. Until it calls completeBoot(), auth
//   events only record the latest session.
// - After boot, applySession() re-renders only when the effective user id
//   actually changes (signed out -> in, in -> out, or user A -> user B).
//   The same user's SIGNED_IN / TOKEN_REFRESHED / USER_UPDATED just keep
//   state.session current, with no rebuild.
// - applySession() is idempotent per identity, so the sign-in form and the
//   auth listener can both call it and the transition still renders once.
// ============================================================
var booting = true;
var appliedUserId = null; // user id the rendered app state reflects

export function userIdOf(session) {
  return (session && session.user && session.user.id) || null;
}

export function isBooting() { return booting; }

export function completeBoot() {
  appliedUserId = userIdOf(state.session);
  booting = false;
}

export async function applySession(session) {
  state.session = session;
  if (booting) return false;
  var id = userIdOf(session);
  if (id === appliedUserId) return false;
  appliedUserId = id;
  resetOrgsInFlight();
  await refreshAdminContext();
  // A newer identity change may have landed while admin context loaded;
  // that change owns the render.
  if (appliedUserId !== id) return false;
  render();
  return true;
}
