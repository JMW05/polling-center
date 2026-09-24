import { sb } from "../supabase-client.js";
import { el, esc, msgBox } from "../shared/helpers.js";
import { optionLabelFull } from "../shared/question-types.js";

// ---- results rendering (shared by public + admin) ----
export async function appendResults(container, poll, dedupKeyForVisibility) {
  var res = await sb.rpc("get_poll_results", { p_poll_id: poll.id, p_dedup_key: dedupKeyForVisibility || null });
  if (res.error) { container.appendChild(msgBox("error", "Couldn't load results.")); return; }
  var data = res.data;
  if (!data.visible) {
    var reasonText = {
      election_not_closed: "This is a secret ballot election. Results stay hidden — including from the organizer — until voting closes.",
      not_open_yet: "Results aren't available until this poll opens.",
      not_yet_visible: "Results aren't visible yet for this poll.",
      not_found: "Poll not found.",
    }[data.reason] || "Results are not visible right now.";
    container.appendChild(msgBox("info", reasonText));
    return;
  }
  var card = el("div", "card");
  card.appendChild(el("h3", null, "Results"));
  card.appendChild(el("div", "muted", data.total_responses + " total " + (data.anonymous ? "ballot" + (data.total_responses === 1 ? "" : "s") : "response" + (data.total_responses === 1 ? "" : "s"))));
  data.questions.forEach(function (q) {
    var qWrap = el("div", null); qWrap.style.marginTop = "14px";
    qWrap.appendChild(el("div", null, q.prompt)).style.fontWeight = "600";
    if (q.question_type === "text") {
      (q.text_answers || []).forEach(function (t) {
        var line = el("div", "muted"); line.style.padding = "4px 0";
        line.textContent = (t.respondent ? t.respondent + ": " : "") + t.text;
        qWrap.appendChild(line);
      });
      if (!q.text_answers || !q.text_answers.length) qWrap.appendChild(el("div", "muted", "No responses yet."));
    } else if (q.question_type === "rating" && q.rating) {
      var rc = q.rating.count || 0;
      qWrap.appendChild(el("div", "muted", rc ? ("Average: " + q.rating.average + " (" + rc + " rating" + (rc === 1 ? "" : "s") + ")") : "No ratings yet."));
      (q.rating.distribution || []).forEach(function (d) {
        var pct = rc > 0 ? Math.round((d.count / rc) * 100) : 0;
        var rowWrap = el("div", "bar-wrap");
        rowWrap.innerHTML =
          '<div class="bar-label"><span>' + esc(String(d.value)) + '</span><span class="pct">' + d.count + " (" + pct + "%)</span></div>" +
          '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>';
        qWrap.appendChild(rowWrap);
      });
    } else {
      // Percentage denominator is the number of DISTINCT respondents who
      // answered this question — never the sum of votes across options.
      // That sum only equals the respondent count for single-select
      // questions; for multi-select/availability one respondent can
      // contribute votes to several options at once, which would
      // otherwise understate every percentage (e.g. 8 of 10 respondents
      // picking Tuesday must read 8/10 = 80%, not get diluted by
      // however many other slots those 8 also picked).
      var total = q.respondents_answering || 0;
      var options = (q.options || []).slice();
      var maxVotes = options.reduce(function (m, o) { return Math.max(m, o.votes || 0); }, 0);
      options.forEach(function (o) {
        var pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
        var isFinal = poll.final_option_id && o.option_id === poll.final_option_id;
        var isTopAvailability = q.question_type === "availability" && !isFinal && maxVotes > 0 && o.votes === maxVotes;
        var rowWrap = el("div", "bar-wrap" + (isFinal ? " final" : "") + (isTopAvailability ? " top" : ""));
        rowWrap.innerHTML =
          '<div class="bar-label"><span>' + esc(optionLabelFull(o, poll.timezone)) + (isTopAvailability ? '<span class="most-avail">most available</span>' : "") + '</span><span class="pct">' + o.votes + " (" + pct + "%)</span></div>" +
          '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>';
        qWrap.appendChild(rowWrap);
        if (o.available_respondents && o.available_respondents.length) {
          qWrap.appendChild(el("div", "respondents-line", "Available: " + o.available_respondents.join(", ")));
        }
      });
      if (total > 0) qWrap.appendChild(el("div", "respondents-line", total + " respondent" + (total === 1 ? "" : "s") + " answered this question"));
    }
    card.appendChild(qWrap);
  });
  container.appendChild(card);
}
