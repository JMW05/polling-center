import { sb } from "../supabase-client.js";
import { navigate, publicPollUrl, currentRenderGeneration, isStaleRender } from "../router.js";
import { subtitle, el, esc, msgBox, typeLabel, statusLabel } from "../shared/helpers.js";
import { fmtDateTime } from "../shared/timezone.js";
import { optionLabelFull } from "../shared/question-types.js";
import { downloadCSV, exportPollResultsCsv } from "../shared/export-csv.js";
import { appendResults } from "../public/results-view.js";

// ============================================================
// ADMIN: poll manage (monitor, lifecycle, results, tokens, csv)
// ============================================================
export async function renderAdminPoll(container, pollId) {
  var back = el("a", "back", "‹ All polls");
  back.addEventListener("click", function () { navigate("#/admin"); });
  container.appendChild(back);

  var gen = currentRenderGeneration();
  var pollRes = await sb.from("polls").select("*").eq("id", pollId).single();
  if (isStaleRender(gen)) return;
  if (pollRes.error) { container.appendChild(msgBox("error", "Couldn't load poll.")); return; }
  var poll = pollRes.data;
  subtitle.textContent = poll.title;

  var head = el("div", "card");
  var badges = el("div", "meta-row");
  badges.innerHTML =
    '<span class="badge ' + poll.poll_type + '">' + esc(typeLabel(poll.poll_type)) + "</span>" +
    '<span class="badge ' + poll.status + '">' + esc(statusLabel(poll.status)) + "</span>" +
    (poll.anonymous ? '<span class="badge secret">Secret ballot</span>' : "");
  head.appendChild(badges);
  head.appendChild(el("h3", null, poll.title));
  if (poll.description) head.appendChild(el("p", "desc", poll.description));
  var whenBits = [];
  if (poll.open_at) whenBits.push("Opens " + fmtDateTime(poll.open_at, poll.timezone));
  if (poll.close_at) whenBits.push((poll.status === "closed" ? "Closed " : "Closes ") + fmtDateTime(poll.close_at, poll.timezone));
  if (whenBits.length) head.appendChild(el("div", "muted", whenBits.join(" · ")));

  if (poll.status === "open" || poll.status === "closed") {
    var linkBox = el("div", "linkbox");
    var urlSpan = el("span", null, publicPollUrl(poll.id));
    urlSpan.style.flex = "1";
    linkBox.appendChild(urlSpan);
    var copyBtn = el("button", "btn secondary", "Copy link");
    copyBtn.type = "button"; copyBtn.style.width = "auto"; copyBtn.style.padding = "6px 10px"; copyBtn.style.fontSize = "12px";
    copyBtn.addEventListener("click", function () {
      navigator.clipboard.writeText(publicPollUrl(poll.id)).then(function () {
        copyBtn.textContent = "Copied!"; setTimeout(function () { copyBtn.textContent = "Copy link"; }, 1500);
      });
    });
    linkBox.appendChild(copyBtn);
    head.appendChild(linkBox);
  }
  container.appendChild(head);

  // participation monitor
  var monRes = await sb.rpc("get_poll_admin_monitor", { p_poll_id: poll.id });
  if (isStaleRender(gen)) return;
  if (!monRes.error && monRes.data) {
    var mon = monRes.data;
    var statCard = el("div", "card");
    var grid = el("div", "stat-grid");
    if (mon.mode === "election_turnout") {
      grid.appendChild(statTile(mon.eligible_count, "Eligible voters"));
      grid.appendChild(statTile(mon.cast_count, "Ballots cast"));
      grid.appendChild(statTile(mon.eligible_count ? Math.round((mon.cast_count / mon.eligible_count) * 100) + "%" : "—", "Turnout"));
    } else {
      grid.appendChild(statTile(mon.response_count, "Responses"));
    }
    statCard.appendChild(grid);
    container.appendChild(statCard);
  }

  // lifecycle actions
  var actionsCard = el("div", "card");
  actionsCard.appendChild(el("label", null, "Manage"));
  var btnRow = el("div", "btn-row");
  var actionMsg = el("div", null);

  function lifecycleBtn(label, cls, fn) {
    var b = el("button", "btn " + cls, label);
    b.type = "button";
    b.addEventListener("click", async function () {
      actionMsg.innerHTML = "";
      b.disabled = true;
      try { await fn(); await reload(); }
      catch (err) { actionMsg.innerHTML = ""; actionMsg.appendChild(msgBox("error", err.message || String(err))); b.disabled = false; }
    });
    return b;
  }
  function reload() { navigate("#/admin/poll/" + poll.id); location.reload(); }

  if (poll.status === "draft") {
    btnRow.appendChild(lifecycleBtn("Edit", "secondary", async function () { navigate("#/admin/edit/" + poll.id); }));
    btnRow.appendChild(lifecycleBtn("Publish now", "", async function () {
      var r = await sb.rpc("publish_poll", { p_poll_id: poll.id }); if (r.error) throw r.error;
    }));
  }
  if (poll.status === "scheduled") {
    btnRow.appendChild(lifecycleBtn("Open now", "", async function () {
      var r = await sb.rpc("publish_poll", { p_poll_id: poll.id }); if (r.error) throw r.error;
    }));
  }
  if (poll.status === "open") {
    btnRow.appendChild(lifecycleBtn("Close poll", "secondary", async function () {
      var r = await sb.rpc("close_poll", { p_poll_id: poll.id }); if (r.error) throw r.error;
    }));
  }
  if (poll.status === "closed" && poll.poll_type !== "election") {
    btnRow.appendChild(lifecycleBtn("Reopen", "secondary", async function () {
      var r = await sb.rpc("reopen_poll", { p_poll_id: poll.id }); if (r.error) throw r.error;
    }));
  }
  if (poll.status === "closed" || poll.status === "open") {
    btnRow.appendChild(lifecycleBtn("Archive", "secondary", async function () {
      var r = await sb.rpc("archive_poll", { p_poll_id: poll.id }); if (r.error) throw r.error;
    }));
  }
  if (poll.results_visibility === "manual" && !poll.results_released_at) {
    btnRow.appendChild(lifecycleBtn("Release results now", "", async function () {
      var r = await sb.rpc("release_results", { p_poll_id: poll.id }); if (r.error) throw r.error;
    }));
  }
  btnRow.appendChild(lifecycleBtn("Duplicate as new draft", "secondary", async function () {
    var r = await sb.rpc("duplicate_poll", { p_poll_id: poll.id, p_new_title: poll.title + " (copy)" });
    if (r.error) throw r.error;
  }));

  actionsCard.appendChild(btnRow);
  actionsCard.appendChild(actionMsg);
  container.appendChild(actionsCard);

  // election tokens
  if (poll.poll_type === "election" || poll.access_mode === "token") {
    var tokenCard = await tokenGeneratorCard(poll);
    if (isStaleRender(gen)) return;
    container.appendChild(tokenCard);
  }

  // results (admin view — same visibility rules as everyone, plus admin_only)
  var resultsCard = el("div", null);
  await appendResults(resultsCard, poll, null);
  if (isStaleRender(gen)) return;
  container.appendChild(resultsCard);

  // meeting: set final time
  if (poll.poll_type === "meeting") {
    var qRes = await sb.from("questions").select("id, options(id,label,slot_start,slot_end,order_index)").eq("poll_id", poll.id).limit(1).single();
    if (isStaleRender(gen)) return;
    if (!qRes.error && qRes.data && qRes.data.options && qRes.data.options.length) {
      var finalCard = el("div", "card");
      finalCard.appendChild(el("label", null, "Set final meeting time"));
      var finalSelect = document.createElement("select");
      var noneOpt = el("option", null, "— Not selected —"); noneOpt.value = "";
      finalSelect.appendChild(noneOpt);
      qRes.data.options.slice().sort(function (a, b) { return a.order_index - b.order_index; }).forEach(function (o) {
        var opt = el("option", null, optionLabelFull(o, poll.timezone)); opt.value = o.id;
        if (poll.final_option_id === o.id) opt.selected = true;
        finalSelect.appendChild(opt);
      });
      finalCard.appendChild(finalSelect);
      var finalBtn = el("button", "btn", "Save final time"); finalBtn.style.marginTop = "10px"; finalBtn.type = "button";
      var finalMsg = el("div", null);
      finalBtn.addEventListener("click", async function () {
        try {
          var r = await sb.rpc("set_final_option", { p_poll_id: poll.id, p_option_id: finalSelect.value || null });
          if (r.error) throw r.error;
          finalMsg.innerHTML = ""; finalMsg.appendChild(msgBox("success", "Saved."));
        } catch (err) { finalMsg.innerHTML = ""; finalMsg.appendChild(msgBox("error", err.message)); }
      });
      finalCard.appendChild(finalBtn); finalCard.appendChild(finalMsg);
      container.appendChild(finalCard);
    }
  }

  // CSV export
  var csvCard = el("div", "card");
  var csvBtn = el("button", "btn secondary", "Export results to CSV"); csvBtn.type = "button";
  csvBtn.addEventListener("click", async function () { await exportPollResultsCsv(poll); });
  csvCard.appendChild(csvBtn);
  container.appendChild(csvCard);
}

export function statTile(n, label) {
  var s = el("div", "stat");
  s.appendChild(el("div", "n", String(n)));
  s.appendChild(el("div", "l", label));
  return s;
}

export async function tokenGeneratorCard(poll) {
  var card = el("div", "card");
  card.appendChild(el("label", null, "Voting credentials"));
  card.appendChild(el("p", "desc", "Generate one single-use code per eligible voter. Codes are shown once, right here — they are hashed before storage and can never be displayed again, so export or copy them immediately."));
  var ta = document.createElement("textarea");
  ta.placeholder = "One name or email per line — used only as your own roster label, never stored on any ballot";
  card.appendChild(ta);
  var genBtn = el("button", "btn", "Generate codes"); genBtn.type = "button"; genBtn.style.marginTop = "10px";
  var out = el("div", null); out.style.marginTop = "10px";
  genBtn.addEventListener("click", async function () {
    var labels = ta.value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
    if (!labels.length) return;
    genBtn.disabled = true;
    try {
      var r = await sb.rpc("generate_election_tokens", { p_poll_id: poll.id, p_labels: labels });
      if (r.error) throw r.error;
      out.innerHTML = "";
      out.appendChild(msgBox("warn", "Save these now — they cannot be shown again."));
      (r.data || []).forEach(function (row) {
        out.appendChild(el("code", "tok", row.label + ":  " + row.token));
      });
      var csvBtn2 = el("button", "btn secondary", "Download codes as CSV"); csvBtn2.type = "button"; csvBtn2.style.marginTop = "8px";
      csvBtn2.addEventListener("click", function () {
        downloadCSV(poll.title.replace(/[^a-z0-9]+/gi, "_") + "_voting_codes.csv",
          [["Label", "Code"]].concat((r.data || []).map(function (row) { return [row.label, row.token]; })));
      });
      out.appendChild(csvBtn2);
      ta.value = "";
    } catch (err) {
      out.innerHTML = ""; out.appendChild(msgBox("error", err.message || String(err)));
    } finally { genBtn.disabled = false; }
  });
  card.appendChild(genBtn); card.appendChild(out);

  var gen = currentRenderGeneration();
  var rosterRes = await sb.from("voter_eligibility").select("label,used").eq("poll_id", poll.id).order("created_at");
  if (isStaleRender(gen)) return card; // caller checks too and discards it
  if (!rosterRes.error && rosterRes.data && rosterRes.data.length) {
    var rosterWrap = el("div", null); rosterWrap.style.marginTop = "12px";
    rosterWrap.appendChild(el("div", "muted", "Issued so far:"));
    rosterRes.data.forEach(function (v) {
      var line = el("div", "muted");
      line.style.padding = "2px 0";
      line.textContent = (v.label || "(unlabeled)") + " — " + (v.used ? "voted" : "not yet voted");
      rosterWrap.appendChild(line);
    });
    card.appendChild(rosterWrap);
  }
  return card;
}
