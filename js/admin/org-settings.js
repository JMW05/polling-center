import { sb } from "../supabase-client.js";
import { state } from "../state.js";
import { el, msgBox } from "../shared/helpers.js";
import { TZ_LIST } from "../shared/timezone.js";

// Organization default-timezone card (formerly inline in renderAdmin).
export function orgTimezoneCard() {
  var curOrg = state.orgs.find(function (o) { return o.id === state.orgId; });
  var tzCard = el("div", "card");
  tzCard.appendChild(el("label", null, "Organization default timezone"));
  tzCard.appendChild(el("div", "hint", "New polls for this organization start with this timezone. Each poll can still override it individually."));
  var orgTzSelect = document.createElement("select");
  var curTz = (curOrg && curOrg.default_timezone) || "America/Chicago";
  TZ_LIST.forEach(function (pair) { var o = el("option", null, pair[1]); o.value = pair[0]; if (pair[0] === curTz) o.selected = true; orgTzSelect.appendChild(o); });
  tzCard.appendChild(orgTzSelect);
  var tzSaveBtn = el("button", "btn secondary", "Save timezone"); tzSaveBtn.type = "button"; tzSaveBtn.style.marginTop = "8px";
  var tzMsg = el("div", null); tzMsg.style.marginTop = "6px";
  tzSaveBtn.addEventListener("click", async function () {
    tzSaveBtn.disabled = true;
    try {
      var r = await sb.rpc("update_org_timezone", { p_org_id: state.orgId, p_timezone: orgTzSelect.value });
      if (r.error) throw r.error;
      if (curOrg) curOrg.default_timezone = orgTzSelect.value;
      tzMsg.innerHTML = ""; tzMsg.appendChild(msgBox("success", "Saved."));
    } catch (err) { tzMsg.innerHTML = ""; tzMsg.appendChild(msgBox("error", err.message || String(err))); }
    finally { tzSaveBtn.disabled = false; }
  });
  tzCard.appendChild(tzSaveBtn); tzCard.appendChild(tzMsg);
  return tzCard;
}
