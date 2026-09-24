import { sb } from "../supabase-client.js";
import { state } from "../state.js";
import { navigate, render } from "../router.js";
import { subtitle, el, esc, msgBox, typeLabel, statusLabel } from "../shared/helpers.js";
import { fmtShort } from "../shared/timezone.js";

export function orgSwitcher(onChange) {
  var wrap = el("div", "org-row");
  var select = document.createElement("select");
  if (!state.orgs.length) {
    var o = el("option", null, "No organizations yet");
    select.appendChild(o); select.disabled = true;
  } else {
    state.orgs.forEach(function (o) {
      var opt = el("option", null, o.name);
      opt.value = o.id;
      if (o.id === state.orgId) opt.selected = true;
      select.appendChild(opt);
    });
  }
  select.addEventListener("change", function () {
    state.orgId = select.value;
    localStorage.setItem("pc_org_id", state.orgId);
    if (onChange) onChange(); else render();
  });
  wrap.appendChild(select);
  return wrap;
}

// ============================================================
// PUBLIC: poll list
// ============================================================
export async function renderPublicList(container) {
  subtitle.textContent = "Vote on meetings, decisions & elections";
  container.appendChild(orgSwitcher());

  if (!state.orgId) {
    container.appendChild(el("div", "empty", "No organizations have been set up yet."));
    return;
  }
  var tabbar = el("div", "tabbar");
  [["open", "Open polls"], ["closed", "Past results"]].forEach(function (pair) {
    var b = el("button", "tab" + (state.orgListTab === pair[0] ? " active" : ""), pair[1]);
    b.addEventListener("click", function () { state.orgListTab = pair[0]; render(); });
    tabbar.appendChild(b);
  });
  container.appendChild(tabbar);

  var listWrap = el("div", null); listWrap.appendChild(el("div", "empty", "Loading…"));
  container.appendChild(listWrap);

  try {
    var res = await sb.rpc("list_public_polls", { p_org_id: state.orgId, p_status: state.orgListTab });
    if (res.error) throw res.error;
    var polls = res.data || [];
    listWrap.innerHTML = "";
    if (!polls.length) {
      listWrap.appendChild(el("div", "empty", state.orgListTab === "open" ? "No open polls right now." : "No past polls yet."));
      return;
    }
    polls.forEach(function (p) { listWrap.appendChild(publicPollCard(p)); });
  } catch (e) {
    listWrap.innerHTML = "";
    listWrap.appendChild(msgBox("error", e.message || String(e)));
  }
}

export function publicPollCard(p) {
  var card = el("div", "card"); card.style.cursor = "pointer";
  var badges = el("div", "meta-row");
  badges.innerHTML =
    '<span class="badge ' + p.poll_type + '">' + esc(typeLabel(p.poll_type)) + "</span>" +
    '<span class="badge ' + p.status + '">' + esc(statusLabel(p.status)) + "</span>" +
    (p.anonymous ? '<span class="badge secret">Secret ballot</span>' : "");
  card.appendChild(badges);
  card.appendChild(el("h3", null, p.title));
  if (p.description) card.appendChild(el("p", "desc", p.description));
  var foot = el("div", "muted");
  var bits = [];
  if (p.close_at) bits.push((p.status === "closed" ? "Closed " : "Closes ") + fmtShort(p.close_at, p.timezone));
  else if (p.status === "open") bits.push("Open now");
  foot.textContent = bits.join(" · ");
  card.appendChild(foot);
  card.addEventListener("click", function () { navigate("#/poll/" + p.id); });
  return card;
}
