import { state } from "./state.js";

// ============================================================
// ROUTER
// ============================================================
export function parseHash() {
  var h = location.hash.replace(/^#\/?/, "");
  var parts = h.split("/").filter(Boolean);
  if (!parts.length) return { view: "list" };
  if (parts[0] === "poll" && parts[1]) return { view: "pollDetail", pollId: parts[1] };
  if (parts[0] === "admin") {
    if (!parts[1]) return { view: "admin" };
    if (parts[1] === "new") return { view: "adminNew" };
    if (parts[1] === "poll" && parts[2]) return { view: "adminPoll", pollId: parts[2] };
    if (parts[1] === "edit" && parts[2]) return { view: "adminEdit", pollId: parts[2] };
  }
  return { view: "list" };
}
export function navigate(hash) { location.hash = hash; }

// The main render() (route table) lives in app.js; views call render()
// through here so no module needs to import app.js.
var renderer = null;
export function setRenderer(fn) { renderer = fn; }
export function render() { return renderer.apply(null, arguments); }

export function mountRouter() {
  window.addEventListener("hashchange", function () { state.route = parseHash(); render(); });
}

export function publicPollUrl(pollId) {
  return location.origin + location.pathname + "#/poll/" + pollId;
}
