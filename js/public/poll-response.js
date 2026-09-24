import { sb } from "../supabase-client.js";
import { navigate } from "../router.js";
import { subtitle, el, esc, msgBox, typeLabel, statusLabel, friendlyError } from "../shared/helpers.js";
import { fmtDateTime } from "../shared/timezone.js";
import { questionField } from "../shared/question-types.js";
import { appendResults } from "./results-view.js";

export function deviceId() {
  var id = localStorage.getItem("pc_device_id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    localStorage.setItem("pc_device_id", id);
  }
  return id;
}

// ============================================================
// PUBLIC: poll detail + voting
// ============================================================
export function currentDedupKeyFor(poll) {
  if (poll.anonymous) return null;
  if (poll.access_mode === "device") return deviceId();
  if (poll.access_mode === "identified") return localStorage.getItem("pc_email_" + poll.id) || null;
  return null;
}

export async function renderPublicPollDetail(container, pollId) {
  var back = el("a", "back", "‹ All polls");
  back.addEventListener("click", function () { navigate("#/"); });
  container.appendChild(back);

  var wrap = el("div", null); wrap.appendChild(el("div", "empty", "Loading…"));
  container.appendChild(wrap);

  var res = await sb.rpc("get_public_poll_detail", { p_poll_id: pollId });
  if (res.error || !res.data || res.data.error) {
    wrap.innerHTML = "";
    wrap.appendChild(msgBox("error", "This poll isn't available. It may not be open yet, or the link may be incorrect."));
    return;
  }
  var poll = res.data;
  wrap.innerHTML = "";

  var head = el("div", "card");
  var badges = el("div", "meta-row");
  badges.innerHTML =
    '<span class="badge ' + poll.poll_type + '">' + esc(typeLabel(poll.poll_type)) + "</span>" +
    '<span class="badge ' + poll.status + '">' + esc(statusLabel(poll.status)) + "</span>" +
    (poll.anonymous ? '<span class="badge secret">Secret ballot</span>' : "");
  head.appendChild(badges);
  head.appendChild(el("h3", null, poll.title));
  if (poll.description) head.appendChild(el("p", "desc", poll.description));
  if (poll.close_at) head.appendChild(el("div", "muted", (poll.status === "closed" ? "Closed " : "Closes ") + fmtDateTime(poll.close_at, poll.timezone)));
  wrap.appendChild(head);

  subtitle.textContent = poll.title;

  var castKey = "pc_cast_" + poll.id;
  var respondedKey = "pc_responded_" + poll.id;
  var alreadyCast = poll.anonymous ? localStorage.getItem(castKey) === "1" : localStorage.getItem(respondedKey) === "1";

  var canRespond = poll.status === "open" && (!alreadyCast || (!poll.anonymous && poll.allow_change_vote));

  var bodyWrap = el("div", null);
  wrap.appendChild(bodyWrap);

  function showResponded() {
    bodyWrap.innerHTML = "";
    var infoCard = el("div", "card");
    infoCard.appendChild(msgBox("success", poll.anonymous ? "Your ballot was recorded. Thanks for voting." : "Thanks — your response was recorded."));
    bodyWrap.appendChild(infoCard);
    appendResults(bodyWrap, poll, currentDedupKeyFor(poll));
  }

  if (canRespond) {
    bodyWrap.appendChild(buildResponseForm(poll, castKey, respondedKey, showResponded));
  } else if (poll.status !== "open") {
    var infoCard = el("div", "card");
    infoCard.appendChild(msgBox("info", poll.status === "closed" ? "This poll is closed." : "This poll isn't open yet."));
    bodyWrap.appendChild(infoCard);
    await appendResults(bodyWrap, poll, currentDedupKeyFor(poll));
  } else {
    showResponded();
  }
}

export function buildResponseForm(poll, castKey, respondedKey, onSuccess) {
  var card = el("div", "card");
  var form = document.createElement("form");

  var needsToken = poll.anonymous;
  var needsIdentity = poll.access_mode === "identified" || poll.access_mode === "restricted_list";

  var tokenInput = null;
  if (needsToken) {
    form.appendChild(el("label", null, "Your voting code"));
    tokenInput = document.createElement("input");
    tokenInput.type = "text";
    tokenInput.placeholder = "Enter the code you were given";
    tokenInput.autocomplete = "off";
    form.appendChild(tokenInput);
    form.appendChild(el("div", "hint", "This is a secret ballot. Your code lets you vote once — it is never linked to your selections."));
  }

  var nameInput = null, emailInput = null;
  if (needsIdentity) {
    form.appendChild(el("label", null, "Your name"));
    nameInput = document.createElement("input"); nameInput.type = "text"; nameInput.maxLength = 120;
    form.appendChild(nameInput);
    form.appendChild(el("label", null, "Your email"));
    emailInput = document.createElement("input"); emailInput.type = "email"; emailInput.maxLength = 200;
    form.appendChild(emailInput);
  }

  var answerGetters = [];
  poll.questions.forEach(function (q) {
    form.appendChild(questionField(q, answerGetters, poll.timezone));
  });

  var msgHolder = el("div", null);
  form.appendChild(msgHolder);

  var submitBtn = el("button", "btn", poll.anonymous ? "Cast ballot" : "Submit response");
  submitBtn.type = "submit";
  submitBtn.style.marginTop = "14px";
  form.appendChild(submitBtn);

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    msgHolder.innerHTML = "";
    var answers;
    try { answers = answerGetters.map(function (g) { return g(); }); }
    catch (err) { msgHolder.appendChild(msgBox("error", err.message)); return; }

    if (needsToken && !tokenInput.value.trim()) {
      msgHolder.appendChild(msgBox("error", "Enter your voting code.")); return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    try {
      if (needsToken) {
        var r1 = await sb.rpc("cast_anonymous_ballot", { p_poll_id: poll.id, p_token: tokenInput.value.trim(), p_answers: answers });
        if (r1.error) throw r1.error;
        localStorage.setItem(castKey, "1");
      } else {
        var dedupKey = poll.access_mode === "device" ? deviceId()
          : (emailInput && emailInput.value.trim() ? emailInput.value.trim().toLowerCase() : null);
        var r2 = await sb.rpc("submit_identified_response", {
          p_poll_id: poll.id,
          p_dedup_key: dedupKey,
          p_respondent_name: nameInput ? nameInput.value.trim() : null,
          p_respondent_email: emailInput ? emailInput.value.trim() : null,
          p_answers: answers,
        });
        if (r2.error) throw r2.error;
        localStorage.setItem(respondedKey, "1");
        if (poll.access_mode === "identified" && dedupKey) localStorage.setItem("pc_email_" + poll.id, dedupKey);
      }
      onSuccess();
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = poll.anonymous ? "Cast ballot" : "Submit response";
      msgHolder.innerHTML = "";
      msgHolder.appendChild(msgBox("error", friendlyError(err)));
    }
  });

  card.appendChild(form);
  return card;
}
