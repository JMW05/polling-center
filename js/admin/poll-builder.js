import { sb } from "../supabase-client.js";
import { state, orgName, currentOrgDefaultTz } from "../state.js";
import { navigate, render, currentRenderGeneration, isStaleRender } from "../router.js";
import { subtitle, el, esc, msgBox, typeLabel, friendlyError, uid, debounce } from "../shared/helpers.js";
import { TZ_LIST, utcIsoToZonedInputValue, zonedTimeToUtcIso } from "../shared/timezone.js";
import { questionField } from "../shared/question-types.js";
import { loadDraftRecovery, saveDraftRecovery, clearDraftRecovery } from "./draft-recovery.js";
import { questionBlock as renderQuestionBlock } from "./poll-builder-questions.js";

// ============================================================
// ADMIN: create / edit poll
// ============================================================
export function newQuestionDraft(type) {
  return {
    key: uid(), question_type: type, prompt: "", required: true,
    max_selections: null, allow_write_in: false, allow_abstain: false,
    rating_min: 1, rating_max: 5,
    options: [],
  };
}
export function newOptionDraft(label) { return { key: uid(), label: label || "", slot_start: "", slot_end: "", is_abstain: false, is_write_in: false }; }

export async function renderPollForm(container, existingPollId) {
  var isEdit = !!existingPollId;
  subtitle.textContent = isEdit ? "Edit draft poll" : "New poll";
  var back = el("a", "back", "‹ Cancel");
  back.addEventListener("click", function () { navigate(isEdit ? "#/admin/poll/" + existingPollId : "#/admin"); });
  container.appendChild(back);

  // draft.open_at / draft.close_at / any option's slot_start / slot_end
  // always hold real UTC ISO instants (or null/""), never raw wall-clock
  // strings — conversion to/from the wall-clock shown in an <input> only
  // ever happens at the render/read boundary, in draft.timezone.
  var draft = {
    poll_type: "meeting",
    title: "", description: "",
    access_mode: "device",
    anonymous: false,
    allow_change_vote: false,
    results_visibility: "after_close",
    show_respondent_identities: false,
    timezone: null,
    open_at: null, close_at: null,
    questions: [],
  };

  var gen = currentRenderGeneration();
  if (isEdit) {
    var pRes = await sb.from("polls").select("*").eq("id", existingPollId).single();
    if (isStaleRender(gen)) return;
    if (pRes.error) { container.appendChild(msgBox("error", "Couldn't load poll.")); return; }
    if (pRes.data.status !== "draft") { container.appendChild(msgBox("error", "Only draft polls can be edited. Duplicate this poll to make changes.")); return; }
    Object.assign(draft, pRes.data);
    var qRes = await sb.from("questions").select("*, options(*)").eq("poll_id", existingPollId).order("order_index");
    if (isStaleRender(gen)) return;
    draft.questions = (qRes.data || []).sort(function (a, b) { return a.order_index - b.order_index; }).map(function (q) {
      var qd = newQuestionDraft(q.question_type);
      Object.assign(qd, { prompt: q.prompt, required: q.required, max_selections: q.max_selections, allow_write_in: q.allow_write_in, allow_abstain: q.allow_abstain, rating_min: q.rating_min || 1, rating_max: q.rating_max || 5 });
      qd.options = (q.options || []).sort(function (a, b) { return a.order_index - b.order_index; }).map(function (o) {
        var od = newOptionDraft(o.label);
        od.slot_start = o.slot_start || ""; od.slot_end = o.slot_end || "";
        od.is_abstain = o.is_abstain; od.is_write_in = o.is_write_in;
        return od;
      });
      return qd;
    });
  }

  // Local draft recovery: scoped to this admin + this org + this
  // specific poll (existingPollId when editing, the constant "new" for
  // the new-poll composer -- there is only ever one in-progress "new
  // poll" draft per org at a time). If a recovery copy exists, we do
  // NOT silently merge it in -- the admin gets to choose, since the
  // server-loaded draft (for an edit) or the blank defaults (for a new
  // poll) are also valid starting points and merging automatically
  // could clobber either.
  var pollKey = isEdit ? existingPollId : "new";
  var adminId = state.session && state.session.user && state.session.user.id;
  var recovery = loadDraftRecovery(adminId, state.orgId, pollKey);

  var card = el("div", "card");

  if (recovery && recovery.draft) {
    var recBanner = el("div", "msg warn", "We found unsaved poll-builder work saved locally from " + new Date(recovery.savedAt).toLocaleString() + ". Restore it, or discard it and start from " + (isEdit ? "the saved draft" : "scratch") + ".");
    card.appendChild(recBanner);
    var recBtnRow = el("div", "btn-row");
    var restoreBtn = el("button", "btn", "Restore draft"); restoreBtn.type = "button";
    var discardBtn = el("button", "btn secondary", "Discard"); discardBtn.type = "button";
    recBtnRow.appendChild(restoreBtn); recBtnRow.appendChild(discardBtn);
    card.appendChild(recBtnRow);
    container.appendChild(card);
    restoreBtn.addEventListener("click", function () {
      Object.assign(draft, recovery.draft);
      card.innerHTML = "";
      buildFormBody();
    });
    discardBtn.addEventListener("click", function () {
      clearDraftRecovery(adminId, state.orgId, pollKey);
      card.innerHTML = "";
      buildFormBody();
    });
    return;
  }

  container.appendChild(card);
  buildFormBody();

  // Everything below builds the actual poll-builder form from the
  // current `draft` object (whichever way it got populated above) and
  // is deferred into its own function so it can be called either
  // immediately or only after the admin resolves the restore/discard
  // choice above.
  function buildFormBody() {
  card.appendChild(el("div", "muted", "Organization: " + orgName(state.orgId)));
  var form = document.createElement("form");

  // type selector
  form.appendChild(el("label", null, "Poll type"));
  var typeChoice = el("div", "type-choice");
  var TYPES = [
    ["meeting", "Meeting availability", "Find the best time"],
    ["choice", "Choice / decision", "Vote on options"],
    ["election", "Election", "Secret ballot"],
    ["survey", "Survey / feedback", "Multiple questions"],
  ];
  var typeInputs = [];
  TYPES.forEach(function (t) {
    var lbl = document.createElement("label");
    var inp = document.createElement("input"); inp.type = "radio"; inp.name = "ptype"; inp.value = t[0];
    if (draft.poll_type === t[0]) inp.checked = true;
    lbl.appendChild(inp);
    var span = document.createElement("span"); span.textContent = t[1];
    var small = document.createElement("span"); small.className = "tdesc"; small.textContent = t[2];
    span.appendChild(small);
    lbl.appendChild(span);
    typeChoice.appendChild(lbl);
    typeInputs.push(inp);
    if (isEdit) inp.disabled = true;
  });
  form.appendChild(typeChoice);

  form.appendChild(el("label", null, "Title"));
  var titleInput = document.createElement("input"); titleInput.type = "text"; titleInput.value = draft.title || "";
  form.appendChild(titleInput);

  form.appendChild(el("label", null, "Description / instructions (optional)"));
  var descInput = document.createElement("textarea"); descInput.value = draft.description || "";
  form.appendChild(descInput);

  // questions area — rebuilt whenever type changes
  var qArea = el("div", null);
  form.appendChild(qArea);

  // common settings
  var settingsWrap = el("div", null);
  form.appendChild(settingsWrap);

  var msgHolder = el("div", null); msgHolder.style.marginTop = "10px";
  form.appendChild(msgHolder);

  var btnRow = el("div", "btn-row"); btnRow.style.marginTop = "14px";
  var previewBtn = el("button", "btn secondary", "Preview"); previewBtn.type = "button";
  var saveDraftBtn = el("button", "btn secondary", "Save as draft"); saveDraftBtn.type = "submit";
  var savePublishBtn = el("button", "btn", "Save & publish"); savePublishBtn.type = "button";
  btnRow.appendChild(previewBtn); btnRow.appendChild(saveDraftBtn); btnRow.appendChild(savePublishBtn);
  form.appendChild(btnRow);

  // preview area (hidden until "Preview" is clicked) — client-side only,
  // built from the current unsaved draft, no database writes, no admin
  // controls, just the same respondent-facing fields a real voter would see.
  var previewWrap = el("div", null); previewWrap.style.display = "none";
  card.appendChild(form);
  card.appendChild(previewWrap);
  // (card is already attached to container by the caller, above.)

  function currentType() { return typeInputs.find(function (i) { return i.checked; }).value; }

  // ------------------------------------------------------------
  // Local draft-recovery autosave. Debounced so it isn't writing on
  // every keystroke; the listener lives on the stable `form` element
  // and relies on input/change event bubbling, so it keeps working
  // across buildSettings()/buildQuestions() innerHTML rebuilds without
  // needing to be re-attached. Never fires for a signed-out admin
  // (adminId is falsy then) since there's no safe per-admin scope to
  // save under.
  // ------------------------------------------------------------
  var draftStatusEl = el("div", "muted", "");
  draftStatusEl.style.fontSize = "12px";
  form.insertBefore(draftStatusEl, btnRow);
  var persistDraftNow = debounce(function () {
    if (!adminId) return;
    pullFormIntoDraft();
    saveDraftRecovery(adminId, state.orgId, pollKey, draft);
    draftStatusEl.textContent = "Draft saved locally · " + new Date().toLocaleTimeString();
  }, 800);
  form.addEventListener("input", persistDraftNow);
  form.addEventListener("change", persistDraftNow);

  // Pulls every currently-displayed form value back into `draft` — the
  // single source of truth. Called before ANY rebuild (buildSettings,
  // buildQuestions) so that removing an option row, changing question
  // type, etc. never silently discards settings the admin already set;
  // and called before preview/save so both always act on exactly what's
  // on screen.
  function pullFormIntoDraft() {
    draft.title = titleInput.value.trim();
    draft.description = descInput.value.trim();
    draft.poll_type = currentType();
    if (settingsWrap._read) Object.assign(draft, settingsWrap._read());
  }

  function buildSettings() {
    pullFormIntoDraft();
    settingsWrap.innerHTML = "";
    var type = currentType();
    var anonForced = type === "election";
    var tzAtRender = draft.timezone || currentOrgDefaultTz();
    draft.timezone = tzAtRender;

    settingsWrap.appendChild(el("label", null, "Who can respond"));
    var accessSelect = document.createElement("select");
    var accessOpts = anonForced
      ? [["token", "Voter codes (secret ballot)"]]
      : [["link", "Anyone with the link"], ["device", "Anyone with the link — one response per device"], ["identified", "Requires name & email"]];
    accessOpts.forEach(function (a) { var o = el("option", null, a[1]); o.value = a[0]; accessSelect.appendChild(o); });
    if (!anonForced) accessSelect.value = draft.access_mode || "link";
    settingsWrap.appendChild(accessSelect);
    if (!anonForced) accessSelect.addEventListener("change", buildSettings);

    var secretLine = null, secretCk = null;
    if (!anonForced && type === "choice") {
      secretLine = el("div", "checkline");
      secretCk = document.createElement("input"); secretCk.type = "checkbox"; secretCk.id = "secretCk";
      secretCk.checked = !!draft.anonymous;
      secretLine.appendChild(secretCk);
      var l = el("label", null, "Secret ballot (requires voter codes, hides who voted what)");
      l.htmlFor = "secretCk"; secretLine.appendChild(l);
      settingsWrap.appendChild(secretLine);
      secretCk.addEventListener("change", buildSettings);
    }
    if (secretCk && secretCk.checked) { accessSelect.disabled = true; accessSelect.value = "token"; }

    settingsWrap.appendChild(el("label", null, "Timezone"));
    var tzSelect = document.createElement("select");
    var tzFound = false;
    TZ_LIST.forEach(function (pair) { var o = el("option", null, pair[1]); o.value = pair[0]; if (pair[0] === tzAtRender) { o.selected = true; tzFound = true; } tzSelect.appendChild(o); });
    if (!tzFound) { var extra = el("option", null, tzAtRender); extra.value = tzAtRender; extra.selected = true; tzSelect.appendChild(extra); }
    settingsWrap.appendChild(tzSelect);
    settingsWrap.appendChild(el("div", "hint", "Meeting time slots and the open/close times below are shown in this timezone — never the browser's."));
    tzSelect.addEventListener("change", function () { buildQuestions(); });

    settingsWrap.appendChild(el("label", null, "Opens"));
    var openInput = document.createElement("input"); openInput.type = "datetime-local"; openInput.value = utcIsoToZonedInputValue(draft.open_at, tzAtRender);
    settingsWrap.appendChild(openInput);
    settingsWrap.appendChild(el("label", null, "Closes (optional, but required for elections)"));
    var closeInput = document.createElement("input"); closeInput.type = "datetime-local"; closeInput.value = utcIsoToZonedInputValue(draft.close_at, tzAtRender);
    settingsWrap.appendChild(closeInput);

    var changeLine = el("div", "checkline");
    var changeCk = document.createElement("input"); changeCk.type = "checkbox"; changeCk.id = "changeCk"; changeCk.checked = !!draft.allow_change_vote;
    changeLine.appendChild(changeCk);
    var cl = el("label", null, "Allow respondents to change their answer before the poll closes"); cl.htmlFor = "changeCk";
    changeLine.appendChild(cl);
    settingsWrap.appendChild(changeLine);

    settingsWrap.appendChild(el("label", null, "Results visibility"));
    var visSelect = document.createElement("select");
    var visOpts = [["admin_only", "Hidden — admin only"], ["after_voting", "Visible after you respond"], ["while_open", "Visible while poll is open"], ["after_close", "Visible after poll closes"], ["manual", "Released manually by admin"]];
    if (type === "election") visOpts = visOpts.filter(function (v) { return v[0] !== "while_open"; });
    var effAccess = anonForced ? "token" : (secretCk && secretCk.checked ? "token" : accessSelect.value);
    // "Visible after you respond" needs a real, reusable dedup key to
    // check server-side — only device mode and identified (email) mode
    // have one. Plain link access and anonymous/token ballots don't, so
    // that choice is simply not offered for them (rather than silently
    // never actually showing anyone results, which is what happened
    // before).
    if (effAccess !== "device" && effAccess !== "identified") visOpts = visOpts.filter(function (v) { return v[0] !== "after_voting"; });
    visOpts.forEach(function (v) { var o = el("option", null, v[1]); o.value = v[0]; visSelect.appendChild(o); });
    var wantVis = type === "election" ? "after_close" : (draft.results_visibility || "after_close");
    if (!visOpts.some(function (v) { return v[0] === wantVis; })) wantVis = "after_close";
    visSelect.value = wantVis;
    settingsWrap.appendChild(visSelect);

    var idLine = el("div", "checkline");
    var idCk = document.createElement("input"); idCk.type = "checkbox"; idCk.id = "idCk"; idCk.checked = !!draft.show_respondent_identities;
    idLine.appendChild(idCk);
    var il = el("label", null, "Show respondent names/identities alongside results"); il.htmlFor = "idCk";
    idLine.appendChild(il);
    settingsWrap.appendChild(idLine);

    // NOTE: anonForced is always a real boolean (type === "election").
    // secretCk is null for every poll type except "choice", so
    // `secretCk && secretCk.checked` evaluates to null (not false) when
    // secretCk is null -- and `false || null` is null in JS, not false.
    // That null was being sent straight through as p_anonymous to the
    // save_poll_draft RPC, which violates polls.anonymous's NOT NULL
    // constraint for every non-election, non-secret-choice poll type
    // (meeting, survey, plain choice). Wrapping in !!(...) forces a
    // real boolean here at the source, regardless of which branch of
    // the || produced the value.
    var anonLock = !!(anonForced || (secretCk && secretCk.checked));
    changeCk.disabled = anonLock; if (anonLock) changeCk.checked = false;
    idCk.disabled = anonLock; if (anonLock) idCk.checked = false;

    settingsWrap._read = function () {
      var anon = !!(anonForced || (secretCk && secretCk.checked));
      return {
        access_mode: anon ? "token" : accessSelect.value,
        anonymous: anon,
        timezone: tzSelect.value,
        open_at: zonedTimeToUtcIso(openInput.value, tzAtRender),
        close_at: zonedTimeToUtcIso(closeInput.value, tzAtRender),
        allow_change_vote: changeCk.checked,
        results_visibility: visSelect.value,
        show_respondent_identities: idCk.checked,
      };
    };
  }

  // Per-question editors live in poll-builder-questions.js; these thin
  // wrappers keep every call site below unchanged.
  var builderCtx = { draft: draft, rebuild: buildQuestions };
  function questionBlock(qd, onRemoveQ, showTypePicker) {
    return renderQuestionBlock(qd, onRemoveQ, showTypePicker, builderCtx);
  }

  function buildQuestions() {
    var type = currentType();
    buildSettings();
    qArea.innerHTML = "";

    if (type === "meeting") {
      if (!draft.questions.length || draft.questions[0].question_type !== "availability") {
        draft.questions = [newQuestionDraft("availability")];
        draft.questions[0].prompt = "When can you attend?";
        draft.questions[0].options = [newOptionDraft(""), newOptionDraft("")];
      }
      qArea.appendChild(questionBlock(draft.questions[0], null, false));
    } else if (type === "choice") {
      if (!draft.questions.length || (draft.questions[0].question_type !== "single_select" && draft.questions[0].question_type !== "multi_select")) {
        draft.questions = [newQuestionDraft("single_select")];
        draft.questions[0].prompt = draft.title || "";
        draft.questions[0].options = [newOptionDraft(""), newOptionDraft("")];
      }
      var mainQ = draft.questions[0];
      var selWrap = el("div", null);
      selWrap.appendChild(el("label", null, "Select up to (1 = single choice)"));
      var selInput = document.createElement("input"); selInput.type = "number"; selInput.min = "1";
      selInput.value = mainQ.max_selections || 1;
      selInput.addEventListener("input", function () {
        var n = parseInt(selInput.value, 10) || 1;
        mainQ.max_selections = n > 1 ? n : null;
        mainQ.question_type = n > 1 ? "multi_select" : "single_select";
      });
      selWrap.appendChild(selInput);
      qArea.appendChild(selWrap);
      qArea.appendChild(questionBlock(mainQ, null, false));

      var hasComment = draft.questions.length > 1;
      var cLine = el("div", "checkline");
      var cCk = document.createElement("input"); cCk.type = "checkbox"; cCk.checked = hasComment;
      cCk.addEventListener("change", function () {
        if (cCk.checked) { var q2 = newQuestionDraft("text"); q2.prompt = "Comments (optional)"; q2.required = false; draft.questions.push(q2); }
        else { draft.questions = [mainQ]; }
        buildQuestions();
      });
      cLine.appendChild(cCk); cLine.appendChild(el("label", null, "Allow an optional comment"));
      qArea.appendChild(cLine);
    } else if (type === "election") {
      if (!draft.questions.length) {
        var race = newQuestionDraft("single_select");
        race.prompt = "";
        race.options = [newOptionDraft(""), newOptionDraft("")];
        draft.questions = [race];
      }
      draft.questions.forEach(function (q) { if (q.question_type === "text" || q.question_type === "availability" || q.question_type === "rating" || q.question_type === "yesno") q.question_type = "single_select"; });
      qArea.appendChild(el("label", null, "Races / questions on this ballot"));
      draft.questions.forEach(function (qd) {
        qArea.appendChild(questionBlock(qd, draft.questions.length > 1 ? function () { draft.questions.splice(draft.questions.indexOf(qd), 1); } : null, false));
      });
      var addRaceBtn = el("button", "btn secondary", "+ Add another race/question"); addRaceBtn.type = "button";
      addRaceBtn.addEventListener("click", function () {
        var r = newQuestionDraft("single_select"); r.options = [newOptionDraft(""), newOptionDraft("")];
        draft.questions.push(r); buildQuestions();
      });
      qArea.appendChild(addRaceBtn);
    } else if (type === "survey") {
      if (!draft.questions.length) draft.questions = [newQuestionDraft("single_select")];
      qArea.appendChild(el("label", null, "Questions"));
      draft.questions.forEach(function (qd) {
        qArea.appendChild(questionBlock(qd, draft.questions.length > 1 ? function () { draft.questions.splice(draft.questions.indexOf(qd), 1); } : null, true));
      });
      var addQBtn = el("button", "btn secondary", "+ Add another question"); addQBtn.type = "button";
      addQBtn.addEventListener("click", function () { draft.questions.push(newQuestionDraft("single_select")); buildQuestions(); });
      qArea.appendChild(addQBtn);
    }
  }

  typeInputs.forEach(function (inp) { inp.addEventListener("change", buildQuestions); });
  buildQuestions();

  function validateDraft() {
    var type = draft.poll_type;
    if (!draft.title) return "Add a title.";
    if (type === "election" && !draft.close_at) return "Elections need a close date/time.";
    var qDrafts = draft.questions;
    for (var i = 0; i < qDrafts.length; i++) {
      if (!qDrafts[i].prompt.trim() && type !== "meeting") return "Every question needs a prompt.";
      if (["single_select", "multi_select"].indexOf(qDrafts[i].question_type) !== -1) {
        var realOpts = qDrafts[i].options.filter(function (o) { return o.label.trim(); });
        if (realOpts.length < 2) return "Each choice question needs at least two options.";
      }
      if (qDrafts[i].question_type === "availability") {
        var slots = qDrafts[i].options.filter(function (o) { return o.slot_start; });
        if (slots.length < 1) return "Add at least one time slot.";
      }
    }
    return null;
  }

  function optionsPayloadFor(qd) {
    if (qd.question_type === "availability") {
      return qd.options.filter(function (o) { return o.slot_start; }).map(function (o) { return { label: null, slot_start: o.slot_start, slot_end: o.slot_end || null }; });
    }
    if (qd.question_type === "single_select" || qd.question_type === "multi_select") {
      return qd.options.filter(function (o) { return o.label && o.label.trim(); }).map(function (o) { return { label: o.label.trim() }; });
    }
    return [];
  }

  function questionsPayload() {
    return draft.questions.map(function (qd) {
      return {
        prompt: (qd.prompt || "").trim() || draft.title,
        question_type: qd.question_type,
        max_selections: qd.max_selections,
        allow_write_in: qd.allow_write_in,
        allow_abstain: qd.allow_abstain,
        required: qd.required,
        rating_min: qd.question_type === "rating" ? qd.rating_min : null,
        rating_max: qd.question_type === "rating" ? qd.rating_max : null,
        options: optionsPayloadFor(qd),
      };
    });
  }

  // ------------------------------------------------------------
  // Preview: renders the current unsaved draft exactly the way a
  // respondent would see it. Purely client-side — no RPC calls, no
  // response is ever created, and nothing here is an admin control.
  // ------------------------------------------------------------
  function previewOptionsFor(qd) {
    if (qd.question_type === "yesno") return [{ id: "y", label: "Yes" }, { id: "n", label: "No" }];
    if (qd.question_type === "availability") {
      return qd.options.filter(function (o) { return o.slot_start; }).map(function (o) { return { id: o.key, slot_start: o.slot_start, slot_end: o.slot_end }; });
    }
    if (qd.question_type === "single_select" || qd.question_type === "multi_select") {
      var opts = qd.options.filter(function (o) { return o.label && o.label.trim(); }).map(function (o) { return { id: o.key, label: o.label.trim() }; });
      if (qd.allow_abstain) opts.push({ id: "__abstain_preview", label: "Abstain", is_abstain: true });
      if (qd.allow_write_in) opts.push({ id: "__writein_preview", label: "Write-in", is_write_in: true });
      return opts;
    }
    return [];
  }
  function draftToPublicShape() {
    return {
      id: "preview", title: draft.title || "(untitled poll)", description: draft.description,
      poll_type: draft.poll_type, status: "open", access_mode: draft.access_mode, anonymous: draft.anonymous,
      timezone: draft.timezone,
      questions: draft.questions.map(function (qd) {
        return {
          id: qd.key, prompt: (qd.prompt || "").trim() || "(untitled question)", question_type: qd.question_type,
          max_selections: qd.max_selections, allow_write_in: qd.allow_write_in, allow_abstain: qd.allow_abstain,
          required: qd.required, rating_min: qd.rating_min, rating_max: qd.rating_max,
          options: previewOptionsFor(qd),
        };
      }),
    };
  }
  previewBtn.addEventListener("click", function () {
    pullFormIntoDraft();
    var publicShape = draftToPublicShape();
    previewWrap.innerHTML = "";
    previewWrap.appendChild(msgBox("warn", "Preview only — this is what a respondent would see. Nothing here is saved or submitted."));

    var pcard = el("div", "card");
    var badges = el("div", "meta-row");
    badges.innerHTML =
      '<span class="badge ' + publicShape.poll_type + '">' + esc(typeLabel(publicShape.poll_type)) + "</span>" +
      '<span class="badge open">Open</span>' +
      (publicShape.anonymous ? '<span class="badge secret">Secret ballot</span>' : "");
    pcard.appendChild(badges);
    pcard.appendChild(el("h3", null, publicShape.title));
    if (publicShape.description) pcard.appendChild(el("p", "desc", publicShape.description));
    previewWrap.appendChild(pcard);

    var respCard = el("div", "card");
    if (publicShape.anonymous) {
      respCard.appendChild(el("label", null, "Your voting code"));
      var ti = document.createElement("input"); ti.type = "text"; ti.disabled = true; ti.placeholder = "(respondents enter their code here)";
      respCard.appendChild(ti);
    }
    if (publicShape.access_mode === "identified") {
      respCard.appendChild(el("label", null, "Your name"));
      var ni = document.createElement("input"); ni.type = "text"; ni.disabled = true;
      respCard.appendChild(ni);
      respCard.appendChild(el("label", null, "Your email"));
      var ei = document.createElement("input"); ei.type = "email"; ei.disabled = true;
      respCard.appendChild(ei);
    }
    var dummyGetters = [];
    publicShape.questions.forEach(function (q) { respCard.appendChild(questionField(q, dummyGetters, draft.timezone)); });
    previewWrap.appendChild(respCard);

    var previewBtnRow = el("div", "btn-row");
    var backBtn = el("button", "btn secondary", "‹ Back to edit"); backBtn.type = "button";
    backBtn.addEventListener("click", function () { previewWrap.style.display = "none"; form.style.display = ""; });
    var publishFromPreviewBtn = el("button", "btn", "Looks good — Save & publish"); publishFromPreviewBtn.type = "button";
    publishFromPreviewBtn.addEventListener("click", function () { saveAll(true); });
    previewBtnRow.appendChild(backBtn); previewBtnRow.appendChild(publishFromPreviewBtn);
    previewWrap.appendChild(previewBtnRow);

    form.style.display = "none";
    previewWrap.style.display = "";
  });

  // ------------------------------------------------------------
  // Save: the ONLY write path for poll structure is the save_poll_draft
  // RPC — one server-side transaction that validates admin authorization,
  // organization scope, and every poll/question/option integrity rule,
  // and either commits the whole poll or rolls back completely. There is
  // no direct insert/update/delete against polls/questions/options from
  // the client (the database no longer grants that to authenticated
  // users at all — see migration 0007).
  // ------------------------------------------------------------
  async function saveAll(alsoPublish) {
    msgHolder.innerHTML = "";
    previewWrap.style.display = "none"; form.style.display = "";
    pullFormIntoDraft();
    // Capture the latest state to local recovery storage on every save
    // attempt, before we know whether it will succeed -- if the save
    // fails (network error, validation error, expired session, etc.)
    // the local copy must still be there afterwards.
    if (adminId) saveDraftRecovery(adminId, state.orgId, pollKey, draft);
    var problem = validateDraft();
    if (problem) { msgHolder.appendChild(msgBox("error", problem)); return; }

    previewBtn.disabled = true; saveDraftBtn.disabled = true; savePublishBtn.disabled = true;
    try {
      var r = await sb.rpc("save_poll_draft", {
        p_poll_id: existingPollId || null,
        p_org_id: state.orgId,
        p_title: draft.title,
        p_description: draft.description,
        p_poll_type: draft.poll_type,
        p_access_mode: draft.access_mode,
        p_anonymous: draft.anonymous,
        p_allow_change_vote: draft.allow_change_vote,
        p_results_visibility: draft.results_visibility,
        p_show_respondent_identities: draft.show_respondent_identities,
        p_timezone: draft.timezone,
        p_open_at: draft.open_at,
        p_close_at: draft.close_at,
        p_questions: questionsPayload(),
      });
      if (r.error) throw r.error;
      var pollId = r.data;
      // save_poll_draft committed successfully -- the local recovery
      // copy has now done its job and would only be stale/confusing if
      // left behind, so clear it. (Deliberately done here, before the
      // publish_poll call below: even if publish fails, the poll
      // structure itself is safely saved server-side as a draft, so
      // there is nothing left for the local copy to protect.)
      if (adminId) clearDraftRecovery(adminId, state.orgId, pollKey);
      if (alsoPublish) {
        var pub = await sb.rpc("publish_poll", { p_poll_id: pollId });
        if (pub.error) throw pub.error;
      }
      navigate("#/admin/poll/" + pollId);
      location.reload();
    } catch (err) {
      var status = err && (err.status || err.statusCode);
      var code = err && err.code;
      var msg = (err && err.message) || String(err);
      var isAuthExpiry = status === 401 || code === "PGRST301" || /jwt|invalid or expired/i.test(msg);
      if (isAuthExpiry) {
        // A real Supabase Auth session expiration (not the benign
        // background TOKEN_REFRESHED case handled in onAuthStateChange
        // above) -- the local draft copy was just saved a moment ago
        // above and is left untouched. Send the admin back to sign in;
        // state.route still points at this exact poll form, so once
        // they're signed in again render() rebuilds this same form and
        // the restore/discard prompt above offers this draft back.
        msgHolder.innerHTML = "";
        msgHolder.appendChild(msgBox("error", "Your sign-in session expired. Your draft is saved locally on this device -- sign in again and you'll be offered the chance to restore it."));
        try { await sb.auth.signOut(); } catch (e) { /* best-effort -- we're forcing local state below regardless */ }
        state.session = null;
        render();
        return;
      }
      msgHolder.innerHTML = ""; msgHolder.appendChild(msgBox("error", friendlyError(err)));
      previewBtn.disabled = false; saveDraftBtn.disabled = false; savePublishBtn.disabled = false;
    }
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); saveAll(false); });
  savePublishBtn.addEventListener("click", function () { saveAll(true); });
  } // end buildFormBody()
}
