// ============================================================
// TIMEZONE
// ============================================================
// A short curated list of common IANA zones with friendly labels.
// If a poll/org is ever configured with a zone not in this list (e.g.
// set directly in the database), it is still added as an extra option
// so it always displays correctly and never falls back to the browser.
export var TZ_LIST = [
  ["America/New_York", "Eastern (New York)"],
  ["America/Chicago", "Central (Chicago)"],
  ["America/Denver", "Mountain (Denver)"],
  ["America/Phoenix", "Mountain, no DST (Phoenix)"],
  ["America/Los_Angeles", "Pacific (Los Angeles)"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
  ["America/Sao_Paulo", "Brasília"],
  ["America/Mexico_City", "Mexico City"],
  ["Europe/London", "London"],
  ["Europe/Paris", "Central Europe (Paris/Berlin)"],
  ["Europe/Moscow", "Moscow"],
  ["Africa/Johannesburg", "Johannesburg"],
  ["Africa/Lagos", "Lagos"],
  ["Africa/Nairobi", "Nairobi"],
  ["Asia/Dubai", "Dubai"],
  ["Asia/Kolkata", "India"],
  ["Asia/Shanghai", "China"],
  ["Asia/Tokyo", "Japan"],
  ["Asia/Singapore", "Singapore"],
  ["Australia/Sydney", "Sydney"],
  ["Pacific/Auckland", "Auckland"],
  ["UTC", "UTC"],
];

export function getZonedOffsetMs(utcMillis, timeZone) {
  var dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  var parts = dtf.formatToParts(new Date(utcMillis)).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
  var asUtc = Date.UTC(
    parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10),
    parts.hour === "24" ? 0 : parseInt(parts.hour, 10), parseInt(parts.minute, 10), parseInt(parts.second, 10)
  );
  return asUtc - utcMillis;
}

// "2026-09-14T15:30" wall-clock entered as local time IN timeZone -> real UTC ISO instant.
export function zonedTimeToUtcIso(localValue, timeZone) {
  if (!localValue) return null;
  timeZone = timeZone || "UTC";
  var m = localValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  var naiveUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
  var offset1 = getZonedOffsetMs(naiveUtc, timeZone);
  var guess1 = naiveUtc - offset1;
  var offset2 = getZonedOffsetMs(guess1, timeZone);
  var guess2 = naiveUtc - offset2;
  return new Date(guess2).toISOString();
}

// Real UTC ISO instant -> "YYYY-MM-DDTHH:MM" wall-clock reading in timeZone, for a datetime-local input.
export function utcIsoToZonedInputValue(iso, timeZone) {
  if (!iso) return "";
  timeZone = timeZone || "UTC";
  try {
    var dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    var parts = dtf.formatToParts(new Date(iso)).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
    return parts.year + "-" + parts.month + "-" + parts.day + "T" + (parts.hour === "24" ? "00" : parts.hour) + ":" + parts.minute;
  } catch (e) { return ""; }
}

export function tzAbbrev(timeZone) {
  try {
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "UTC", timeZoneName: "short" }).formatToParts(new Date());
    var p = parts.find(function (x) { return x.type === "timeZoneName"; });
    return p ? p.value : (timeZone || "UTC");
  } catch (e) { return timeZone || "UTC"; }
}

export function fmtDateTime(iso, tz) {
  if (!iso) return "";
  tz = tz || "UTC";
  try {
    return new Date(iso).toLocaleString(undefined, { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " " + tzAbbrev(tz);
  } catch (e) { return iso; }
}
export function fmtShort(iso, tz) {
  if (!iso) return "";
  tz = tz || "UTC";
  try { return new Date(iso).toLocaleString(undefined, { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch (e) { return iso; }
}
export function fmtTimeOnly(iso, tz) {
  if (!iso) return "";
  tz = tz || "UTC";
  try { return new Date(iso).toLocaleTimeString(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }); }
  catch (e) { return iso; }
}
