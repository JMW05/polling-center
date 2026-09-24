// Header subtitle element -- set by each view as it renders.
export var subtitle = document.getElementById("subtitle");

// ============================================================
// HELPERS
// ============================================================
export function esc(s) {
  var d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}
export function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
export function typeLabel(t) {
  return { meeting: "Meeting availability", choice: "Choice / decision", election: "Election (secret ballot)", survey: "Survey / feedback" }[t] || t;
}
export function statusLabel(s) {
  return { draft: "Draft", scheduled: "Scheduled", open: "Open", closed: "Closed", archived: "Archived" }[s] || s;
}
export function msgBox(cls, text) {
  var m = el("div", "msg " + cls, text);
  return m;
}
export function uid() { return "t" + Math.random().toString(36).slice(2) + Date.now().toString(36); }

export function friendlyError(err) {
  var m = (err && err.message) || String(err);
  var map = {
    invalid_token: "That voting code isn't valid.",
    token_already_used: "That voting code has already been used.",
    poll_not_open: "This poll isn't open right now.",
    poll_not_open_yet: "This poll hasn't opened yet.",
    poll_past_close: "This poll has already closed.",
    already_responded: "You've already responded to this poll.",
    missing_required_question: "Please answer all required questions.",
    question_requires_a_selection: "Please make a selection for every required question.",
    too_many_selections: "You selected more options than this question allows.",
    only_one_selection_allowed: "This question only allows one selection.",
    not_authorized: "You don't have permission to do that.",
    title_required: "Add a title.",
    at_least_one_question_required: "Add at least one question.",
    elections_require_a_close_date: "Elections need a close date/time.",
    choice_question_needs_two_options: "Each choice question needs at least two options.",
    availability_needs_at_least_one_slot: "Add at least one time slot.",
    poll_not_draft_editable: "Only draft polls can be edited. Duplicate this poll to make changes.",
  };
  for (var k in map) if (m.indexOf(k) !== -1) return map[k];
  return m;
}

export function debounce(fn, ms) {
  var t = null;
  return function () {
    var args = arguments, ctx = this;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(ctx, args); }, ms);
  };
}
