// Fake supabase-js UMD global for tests/frontend-equivalence. No network access;
// never talks to the real Supabase project. Fixture data only.
(function () {
  function log(kind, name, args) { try { window.__log(JSON.stringify({ kind: kind, name: name, args: args })); } catch (e) {} }
  var ORGS = [
    { id: "org-1", name: "TCABC", default_timezone: "America/Chicago" },
    { id: "org-2", name: "TCRDF", default_timezone: "America/New_York" },
  ];
  var base = { description: "Desc here", open_at: "2026-09-01T14:00:00Z", close_at: "2026-10-01T22:00:00Z", timezone: "America/Chicago",
    allow_change_vote: false, results_visibility: "while_open", show_respondent_identities: false, final_option_id: null, results_released_at: null, org_id: "org-1", created_at: "2026-09-01T00:00:00Z" };
  function P(o) { return Object.assign({}, base, o); }
  var POLLS = {
    "p-meet": P({ id: "p-meet", title: "Board meeting", poll_type: "meeting", status: "open", access_mode: "device", anonymous: false, final_option_id: "o-m2" }),
    "p-choice": P({ id: "p-choice", title: "Pick a venue", poll_type: "choice", status: "open", access_mode: "identified", anonymous: false, allow_change_vote: true, results_visibility: "manual" }),
    "p-elec": P({ id: "p-elec", title: "Officer election", poll_type: "election", status: "open", access_mode: "token", anonymous: true, results_visibility: "after_close" }),
    "p-survey": P({ id: "p-survey", title: "Feedback", poll_type: "survey", status: "open", access_mode: "link", anonymous: false, close_at: null }),
    "p-closed": P({ id: "p-closed", title: "Old decision", poll_type: "choice", status: "closed", access_mode: "link", anonymous: false }),
    "p-draft": P({ id: "p-draft", title: "Draft survey", poll_type: "survey", status: "draft", access_mode: "device", anonymous: false }),
  };
  var Q = {
    "p-meet": [{ id: "q-m", order_index: 0, prompt: "When can you attend?", question_type: "availability", required: true, max_selections: null, allow_write_in: false, allow_abstain: false,
      options: [{ id: "o-m2", order_index: 1, label: null, slot_start: "2026-10-02T15:00:00Z", slot_end: "2026-10-02T16:00:00Z" }, { id: "o-m1", order_index: 0, label: null, slot_start: "2026-10-01T15:00:00Z", slot_end: null }] }],
    "p-choice": [{ id: "q-c", order_index: 0, prompt: "Venue?", question_type: "single_select", required: true, max_selections: 2, allow_write_in: true,
      options: [{ id: "o-c1", order_index: 0, label: "Hall A" }, { id: "o-c2", order_index: 1, label: "Hall B" }, { id: "o-cw", order_index: 2, label: "Write-in", is_write_in: true }] },
      { id: "q-c2", order_index: 1, prompt: "Comments (optional)", question_type: "text", required: false, options: [] }],
    "p-elec": [{ id: "q-e", order_index: 0, prompt: "President", question_type: "single_select", required: true, max_selections: 1,
      options: [{ id: "o-e1", order_index: 0, label: "Alice" }, { id: "o-e2", order_index: 1, label: "Bob" }, { id: "o-ea", order_index: 2, label: "Abstain", is_abstain: true }] }],
    "p-survey": [
      { id: "q-s1", order_index: 0, prompt: "Which topics?", question_type: "multi_select", required: true, max_selections: 2, options: [{ id: "o-s1", order_index: 0, label: "A" }, { id: "o-s2", order_index: 1, label: "B" }, { id: "o-s3", order_index: 2, label: "C" }] },
      { id: "q-s2", order_index: 1, prompt: "Happy?", question_type: "yesno", required: true, options: [{ id: "o-y", order_index: 0, label: "Yes" }, { id: "o-n", order_index: 1, label: "No" }] },
      { id: "q-s3", order_index: 2, prompt: "Rate it", question_type: "rating", required: true, rating_min: 1, rating_max: 5, options: [] },
      { id: "q-s4", order_index: 3, prompt: "Anything else?", question_type: "text", required: false, options: [] }],
    "p-closed": [{ id: "q-x", order_index: 0, prompt: "Old?", question_type: "single_select", required: true, options: [{ id: "o-x1", order_index: 0, label: "Yes" }, { id: "o-x2", order_index: 1, label: "No" }] }],
    "p-draft": [
      { id: "q-d2", order_index: 1, prompt: "Rate us", question_type: "rating", required: false, max_selections: null, allow_write_in: false, allow_abstain: false, rating_min: 0, rating_max: 10, options: [] },
      { id: "q-d1", order_index: 0, prompt: "Pick", question_type: "single_select", required: true, max_selections: null, allow_write_in: false, allow_abstain: true,
        options: [{ id: "o-d2", order_index: 1, label: "Two", slot_start: null, slot_end: null, is_abstain: false, is_write_in: false }, { id: "o-d1", order_index: 0, label: "One", slot_start: null, slot_end: null, is_abstain: false, is_write_in: false }] }],
  };
  function results(pollId) {
    if (pollId === "p-elec") return { visible: false, reason: "election_not_closed" };
    if (pollId === "p-survey") return { visible: false, reason: "not_yet_visible" };
    var qs = (Q[pollId] || []).map(function (q) {
      if (q.question_type === "text") return { prompt: q.prompt, question_type: "text", text_answers: [{ respondent: "Ann", text: "Nice, \"quoted\", ok" }, { text: "anon line" }] };
      if (q.question_type === "rating") return { prompt: q.prompt, question_type: "rating", rating: { count: 3, average: 4.3, distribution: [{ value: 4, count: 2 }, { value: 5, count: 1 }] } };
      return { prompt: q.prompt, question_type: q.question_type, respondents_answering: 5, options: q.options.map(function (o, i) {
        return { option_id: o.id, label: o.label, slot_start: o.slot_start, slot_end: o.slot_end, votes: 3 - i, available_respondents: q.question_type === "availability" ? ["Ann", "Bo"] : null }; }) };
    });
    return { visible: true, total_responses: pollId === "p-closed" ? 1 : 5, anonymous: false, questions: qs };
  }
  function flag(k) { try { return localStorage.getItem("stub_" + k); } catch (e) { return null; } }
  function rpc(name, args) {
    log("rpc", name, args || null);
    var ok = function (d) { return Promise.resolve({ data: d === undefined ? null : d, error: null }); };
    switch (name) {
      case "is_platform_owner": return ok(flag("owner") !== "0");
      case "list_public_polls": return ok(Object.values(POLLS).filter(function (p) { return p.org_id === args.p_org_id && p.status === args.p_status; }));
      case "get_public_poll_detail": {
        var p = POLLS[args.p_poll_id]; if (!p || p.status === "draft") return ok({ error: "not_found" });
        return ok(Object.assign({}, p, { questions: Q[p.id] }));
      }
      case "get_poll_results": return ok(results(args.p_poll_id));
      case "get_poll_admin_monitor": return ok(args.p_poll_id === "p-elec" ? { mode: "election_turnout", eligible_count: 10, cast_count: 4 } : { mode: "responses", response_count: 7 });
      case "generate_election_tokens": return ok(args.p_labels.map(function (l, i) { return { label: l, token: "TOK-" + i + "-" + l.length }; }));
      case "save_poll_draft": {
        var f = flag("fail_save");
        if (f === "auth") { localStorage.removeItem("stub_fail_save"); return Promise.resolve({ data: null, error: { message: "JWT expired", code: "PGRST301", status: 401 } }); }
        if (f === "val") { localStorage.removeItem("stub_fail_save"); return Promise.resolve({ data: null, error: { message: "choice_question_needs_two_options" } }); }
        return ok("p-meet");
      }
      case "cast_anonymous_ballot": if (args.p_token === "bad") return Promise.resolve({ data: null, error: { message: "invalid_token" } }); return ok(true);
      case "bootstrap_platform_owner": return Promise.resolve({ data: null, error: { message: "not_authorized" } });
      default: return ok(null);
    }
  }
  function from(table) {
    var ops = [];
    var qb = {};
    ["select", "eq", "order", "limit", "single", "insert", "update", "delete"].forEach(function (m) {
      qb[m] = function () { ops.push([m].concat(Array.prototype.slice.call(arguments))); return qb; };
    });
    qb.then = function (res, rej) {
      log("from", table, ops);
      var eqs = {}; ops.forEach(function (o) { if (o[0] === "eq") eqs[o[1]] = o[2]; });
      var single = ops.some(function (o) { return o[0] === "single"; });
      var data = null;
      if (table === "organizations") data = ORGS;
      else if (table === "org_admins") data = [{ org_id: "org-1" }];
      else if (table === "polls") {
        if (eqs.id) data = POLLS[eqs.id] || null;
        else data = Object.values(POLLS).filter(function (p) { return p.org_id === eqs.org_id && p.status === eqs.status; });
      } else if (table === "questions") {
        var qs = JSON.parse(JSON.stringify(Q[eqs.poll_id] || []));
        data = single ? qs[0] : qs;
      } else if (table === "voter_eligibility") data = [{ label: "Ann", used: true }, { label: null, used: false }];
      return Promise.resolve({ data: data, error: data === null && single ? { message: "not found" } : null }).then(res, rej);
    };
    return qb;
  }
  var listeners = [];
  function sess() { var s = flag("session"); return s ? JSON.parse(s) : null; }
  function fire(evt) { var s = sess(); setTimeout(function () { listeners.forEach(function (cb) { cb(evt, s); }); }, 0); }
  var auth = {
    getSession: function () { log("auth", "getSession", null); return Promise.resolve({ data: { session: sess() }, error: null }); },
    onAuthStateChange: function (cb) { log("auth", "onAuthStateChange", null); listeners.push(cb); fire("INITIAL_SESSION"); return { data: { subscription: { unsubscribe: function () {} } } }; },
    signInWithPassword: function (c) {
      log("auth", "signInWithPassword", { email: c.email });
      if (c.password !== "pw") return Promise.resolve({ data: { session: null }, error: { message: "Invalid login credentials" } });
      var s = { access_token: "x", user: { id: "admin-1", email: c.email } };
      localStorage.setItem("stub_session", JSON.stringify(s)); fire("SIGNED_IN");
      return Promise.resolve({ data: { session: s }, error: null });
    },
    signUp: function (c) { log("auth", "signUp", c); return Promise.resolve({ data: { session: null }, error: null }); },
    signOut: function () { log("auth", "signOut", null); localStorage.removeItem("stub_session"); fire("SIGNED_OUT"); return Promise.resolve({ error: null }); },
  };
  window.supabase = { createClient: function (url, key) { log("init", "createClient", { url: url, keyRole: JSON.parse(atob(key.split(".")[1])).role }); return { rpc: rpc, from: from, auth: auth }; } };
})();
