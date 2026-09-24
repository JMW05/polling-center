import { sb } from "../supabase-client.js";
import { optionLabelFull } from "./question-types.js";

export function csvEscape(v) {
  v = v == null ? "" : String(v);
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
export function downloadCSV(filename, rows) {
  var csv = rows.map(function (r) { return r.map(csvEscape).join(","); }).join("\r\n");
  var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}

// Results CSV export for the admin poll page (click handler body moved here unchanged).
export async function exportPollResultsCsv(poll) {
  var r = await sb.rpc("get_poll_results", { p_poll_id: poll.id });
  if (r.error || !r.data.visible) { alert("Results aren't visible yet, so there's nothing to export."); return; }
  var rows = [["Question", "Option", "Votes", "Percent", "Respondents answering"]];
  r.data.questions.forEach(function (q) {
    var total = q.respondents_answering || 0;
    if (q.question_type === "text") {
      (q.text_answers || []).forEach(function (t) { rows.push([q.prompt, t.respondent || "", t.text, "", ""]); });
    } else if (q.question_type === "rating" && q.rating) {
      (q.rating.distribution || []).forEach(function (d) {
        var pct = q.rating.count > 0 ? Math.round((d.count / q.rating.count) * 100) : 0;
        rows.push([q.prompt, "Rating " + d.value, d.count, pct + "%", q.rating.count]);
      });
    } else {
      (q.options || []).forEach(function (o) {
        var pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
        rows.push([q.prompt, optionLabelFull(o, poll.timezone), o.votes, pct + "%", total]);
      });
    }
  });
  downloadCSV(poll.title.replace(/[^a-z0-9]+/gi, "_") + "_results.csv", rows);
}
