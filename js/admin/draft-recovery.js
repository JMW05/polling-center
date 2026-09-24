// ============================================================
// POLL-BUILDER LOCAL DRAFT RECOVERY
//
// Purely a client-side safety net against in-progress poll-builder work
// getting wiped by a page reload, a Netlify redeploy landing mid-edit, or
// an auth interruption -- NOT a sync mechanism and NOT a substitute for
// save_poll_draft. Scoped to (admin id + org id + poll key) so one
// admin's local recovery copy never shows up for another admin or
// another org sharing the same browser profile. Holds only the same
// plain poll-builder fields already present in the in-memory `draft`
// object (title, description, poll type, questions/options/slots,
// access mode, timezone, open/close times, allow-change-vote,
// results-visibility, show-respondent-identities) -- never passwords,
// election voter codes, auth tokens, or any other secret, because none
// of those are ever part of that `draft` object in the first place
// (voter codes are generated through a separate flow after a poll is
// already published, never stored in the poll-builder draft).
// ============================================================
export var DRAFT_RECOVERY_PREFIX = "pc_draft_recovery::";
export function draftRecoveryKey(adminId, orgId, pollKey) {
  return DRAFT_RECOVERY_PREFIX + adminId + "::" + orgId + "::" + pollKey;
}
export function saveDraftRecovery(adminId, orgId, pollKey, draftObj) {
  if (!adminId || !orgId || !pollKey) return;
  try {
    localStorage.setItem(
      draftRecoveryKey(adminId, orgId, pollKey),
      JSON.stringify({ savedAt: Date.now(), draft: draftObj })
    );
  } catch (e) { /* best-effort only -- storage full, private mode, etc. */ }
}
export function loadDraftRecovery(adminId, orgId, pollKey) {
  if (!adminId || !orgId || !pollKey) return null;
  try {
    var raw = localStorage.getItem(draftRecoveryKey(adminId, orgId, pollKey));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
export function clearDraftRecovery(adminId, orgId, pollKey) {
  if (!adminId || !orgId || !pollKey) return;
  try { localStorage.removeItem(draftRecoveryKey(adminId, orgId, pollKey)); } catch (e) { /* ignore */ }
}
