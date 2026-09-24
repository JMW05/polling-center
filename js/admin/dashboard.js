import { sb } from "../supabase-client.js";
import { state, isAdminOfOrg, loadOrgs, orgName } from "../state.js";
import { navigate, render } from "../router.js";
import { subtitle, el, esc, msgBox, typeLabel, statusLabel } from "../shared/helpers.js";
import { orgTimezoneCard } from "./org-settings.js";

// ============================================================
// ADMIN: dashboard
// ============================================================
export async function renderAdmin(container) {
  subtitle.textContent = "Admin panel";

  if (state.isPlatformOwner) {
    var addOrgCard = el("div", "card");
    addOrgCard.appendChild(el("label", null, "Create an organization"));
    var orgForm = document.createElement("form");
    orgForm.style.display = "flex"; orgForm.style.gap = "8px";
    var orgInput = document.createElement("input"); orgInput.type = "text"; orgInput.placeholder = "e.g. TCABC";
    orgForm.appendChild(orgInput);
    var orgBtn = el("button", "btn", "Add"); orgBtn.type = "submit"; orgBtn.style.width = "auto";
    orgForm.appendChild(orgBtn);
    var orgMsg = el("div", null);
    orgForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (!orgInput.value.trim()) return;
      try {
        var r = await sb.rpc("create_organization", { p_name: orgInput.value.trim() });
        if (r.error) throw r.error;
        orgInput.value = "";
        await loadOrgs();
        render();
      } catch (err) {
        orgMsg.innerHTML = ""; orgMsg.appendChild(msgBox("error", err.message || String(err)));
      }
    });
    addOrgCard.appendChild(orgForm); addOrgCard.appendChild(orgMsg);
    container.appendChild(addOrgCard);
  }

  var visibleOrgs = state.orgs.filter(function (o) { return isAdminOfOrg(o.id); });
  if (!state.orgId || !isAdminOfOrg(state.orgId)) {
    state.orgId = visibleOrgs.length ? visibleOrgs[0].id : null;
  }
  if (!visibleOrgs.length) {
    container.appendChild(el("div", "empty", "You aren't an admin on any organization yet."));
    return;
  }

  var switcherWrap = el("div", "org-row");
  var select = document.createElement("select");
  visibleOrgs.forEach(function (o) {
    var opt = el("option", null, o.name); opt.value = o.id;
    if (o.id === state.orgId) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener("change", function () { state.orgId = select.value; localStorage.setItem("pc_org_id", state.orgId); render(); });
  switcherWrap.appendChild(select);
  container.appendChild(switcherWrap);

  container.appendChild(orgTimezoneCard());

  var newPollBtn = el("button", "btn", "+ New poll for " + orgName(state.orgId));
  newPollBtn.style.marginBottom = "14px";
  newPollBtn.addEventListener("click", function () { navigate("#/admin/new"); });
  container.appendChild(newPollBtn);

  var tabbar = el("div", "tabbar");
  ["draft", "scheduled", "open", "closed", "archived"].forEach(function (t) {
    var b = el("button", "tab" + (state.adminTab === t ? " active" : ""), statusLabel(t));
    b.addEventListener("click", function () { state.adminTab = t; render(); });
    tabbar.appendChild(b);
  });
  container.appendChild(tabbar);

  var listWrap = el("div", null); listWrap.appendChild(el("div", "empty", "Loading…"));
  container.appendChild(listWrap);

  var res = await sb.from("polls").select("*").eq("org_id", state.orgId).eq("status", state.adminTab).order("created_at", { ascending: false });
  listWrap.innerHTML = "";
  if (res.error) { listWrap.appendChild(msgBox("error", res.error.message)); return; }
  var polls = res.data || [];
  if (!polls.length) { listWrap.appendChild(el("div", "empty", "No " + statusLabel(state.adminTab).toLowerCase() + " polls.")); return; }
  polls.forEach(function (p) { listWrap.appendChild(adminPollCard(p)); });
}

export function adminPollCard(p) {
  var card = el("div", "card"); card.style.cursor = "pointer";
  var badges = el("div", "meta-row");
  badges.innerHTML =
    '<span class="badge ' + p.poll_type + '">' + esc(typeLabel(p.poll_type)) + "</span>" +
    '<span class="badge ' + p.status + '">' + esc(statusLabel(p.status)) + "</span>" +
    (p.anonymous ? '<span class="badge secret">Secret ballot</span>' : "");
  card.appendChild(badges);
  card.appendChild(el("h3", null, p.title));
  card.addEventListener("click", function (e) {
    if (e.target.closest("button")) return;
    navigate("#/admin/poll/" + p.id);
  });
  return card;
}
