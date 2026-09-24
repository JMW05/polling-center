import { sb } from "./supabase-client.js";

// ============================================================
// STATE
// ============================================================
export var state = {
  session: null,
  isPlatformOwner: false,
  adminOrgIds: null, // null = unknown/not admin at all; array of org ids otherwise
  orgs: [],
  orgId: localStorage.getItem("pc_org_id") || null,
  orgListTab: "open", // public list tab
  adminTab: "draft,scheduled,open,closed,archived".split(",")[2], // default "open"
  route: { view: "list" },
  busy: false,
  bootstrapAttempted: false,
};

// ============================================================
// ADMIN CONTEXT (derived from the auth session)
// ============================================================
export async function refreshAdminContext() {
  if (!state.session) { state.isPlatformOwner = false; state.adminOrgIds = null; return; }
  var uidv = state.session.user.id;
  try {
    var ownerRes = await sb.rpc("is_platform_owner", { p_uid: uidv });
    state.isPlatformOwner = !!ownerRes.data;
  } catch (e) { state.isPlatformOwner = false; }
  try {
    var rows = await sb.from("org_admins").select("org_id").eq("user_id", uidv);
    var scoped = (rows.data || []).map(function (r) { return r.org_id; });
    state.adminOrgIds = state.isPlatformOwner ? "all" : scoped;
  } catch (e) { state.adminOrgIds = state.isPlatformOwner ? "all" : []; }
}
export function isAdminOfOrg(orgId) {
  if (!state.session) return false;
  if (state.adminOrgIds === "all") return true;
  return Array.isArray(state.adminOrgIds) && state.adminOrgIds.indexOf(orgId) !== -1;
}
export function hasAnyAdminRole() {
  return state.isPlatformOwner || (Array.isArray(state.adminOrgIds) && state.adminOrgIds.length > 0);
}

// ============================================================
// ORGS
// ============================================================
export async function loadOrgs() {
  var res = await sb.from("organizations").select("id,name,default_timezone").order("name");
  if (res.error) throw res.error;
  state.orgs = res.data || [];
  if (!state.orgId || !state.orgs.some(function (o) { return o.id === state.orgId; })) {
    state.orgId = state.orgs.length ? state.orgs[0].id : null;
  }
  if (state.orgId) localStorage.setItem("pc_org_id", state.orgId);
}
export function orgName(id) {
  var o = state.orgs.find(function (x) { return x.id === id; });
  return o ? o.name : "";
}
export function currentOrgDefaultTz() {
  var o = state.orgs.find(function (x) { return x.id === state.orgId; });
  return (o && o.default_timezone) || "America/Chicago";
}
