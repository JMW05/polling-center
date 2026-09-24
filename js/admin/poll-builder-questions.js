import { el } from "../shared/helpers.js";
import { currentOrgDefaultTz } from "../state.js";
import { utcIsoToZonedInputValue, zonedTimeToUtcIso } from "../shared/timezone.js";
import { newOptionDraft } from "./poll-builder.js";

// Per-question editors for the poll builder, moved out of renderPollForm's
// buildFormBody(). `ctx` carries the two closure values they used there:
//   ctx.draft   -- the builder's single `draft` object (same object, never copied)
//   ctx.rebuild -- buildQuestions(), called exactly where it was called before

export function optionEditRow(qd, od, onRemove, isSlot, ctx) {
  var row = el("div", isSlot ? "slot-row" : "option-edit-row");
  if (isSlot) {
    var tz = ctx.draft.timezone || currentOrgDefaultTz();
    var s = document.createElement("input"); s.type = "datetime-local"; s.value = utcIsoToZonedInputValue(od.slot_start, tz);
    s.addEventListener("input", function () { od.slot_start = zonedTimeToUtcIso(s.value, tz); });
    row.appendChild(s);
    var span = el("span", "muted", "to");
    row.appendChild(span);
    var e2 = document.createElement("input"); e2.type = "datetime-local"; e2.value = utcIsoToZonedInputValue(od.slot_end, tz);
    e2.addEventListener("input", function () { od.slot_end = zonedTimeToUtcIso(e2.value, tz); });
    row.appendChild(e2);
  } else {
    var t = document.createElement("input"); t.type = "text"; t.placeholder = "Option text"; t.value = od.label || "";
    t.addEventListener("input", function () { od.label = t.value; });
    row.appendChild(t);
  }
  var rm = el("button", "rm", "×"); rm.type = "button";
  rm.addEventListener("click", function () { onRemove(); ctx.rebuild(); });
  row.appendChild(rm);
  return row;
}

export function questionBlock(qd, onRemoveQ, showTypePicker, ctx) {
  var block = el("div", "qblock");
  var headRow = el("div", "qblock-head");
  var pInput = document.createElement("input"); pInput.type = "text"; pInput.placeholder = "Question / prompt";
  pInput.value = qd.prompt || "";
  pInput.addEventListener("input", function () { qd.prompt = pInput.value; });
  headRow.appendChild(pInput);
  if (onRemoveQ) {
    var rmq = el("button", "rmq", "×"); rmq.type = "button";
    rmq.addEventListener("click", function () { onRemoveQ(); ctx.rebuild(); });
    headRow.appendChild(rmq);
  }
  block.appendChild(headRow);

  if (showTypePicker) {
    var typeSel = document.createElement("select");
    [["single_select", "Single choice"], ["multi_select", "Multiple choice"], ["yesno", "Yes / No"], ["rating", "Rating scale"], ["text", "Free response"]].forEach(function (t) {
      var o = el("option", null, t[1]); o.value = t[0]; typeSel.appendChild(o);
    });
    typeSel.value = qd.question_type;
    typeSel.addEventListener("change", function () { qd.question_type = typeSel.value; ctx.rebuild(); });
    block.appendChild(typeSel);
  }

  var reqLine = el("div", "checkline");
  var reqCk = document.createElement("input"); reqCk.type = "checkbox"; reqCk.checked = qd.required;
  reqCk.addEventListener("change", function () { qd.required = reqCk.checked; });
  reqLine.appendChild(reqCk); reqLine.appendChild(el("label", null, "Required"));
  block.appendChild(reqLine);

  if (qd.question_type === "single_select" || qd.question_type === "multi_select" || qd.question_type === "election_race") {
    var maxLabel = el("label", null, "Select up to (blank = unlimited for multi-choice, 1 for single)");
    block.appendChild(maxLabel);
    var maxInput = document.createElement("input"); maxInput.type = "number"; maxInput.min = "1";
    maxInput.value = qd.max_selections || "";
    maxInput.addEventListener("input", function () { qd.max_selections = maxInput.value ? parseInt(maxInput.value, 10) : null; });
    block.appendChild(maxInput);

    var wiLine = el("div", "checkline");
    var wiCk = document.createElement("input"); wiCk.type = "checkbox"; wiCk.checked = qd.allow_write_in;
    wiCk.addEventListener("change", function () { qd.allow_write_in = wiCk.checked; ctx.rebuild(); });
    wiLine.appendChild(wiCk); wiLine.appendChild(el("label", null, "Allow write-in"));
    block.appendChild(wiLine);

    var abLine = el("div", "checkline");
    var abCk = document.createElement("input"); abCk.type = "checkbox"; abCk.checked = qd.allow_abstain;
    abCk.addEventListener("change", function () { qd.allow_abstain = abCk.checked; ctx.rebuild(); });
    abLine.appendChild(abCk); abLine.appendChild(el("label", null, "Allow abstain"));
    block.appendChild(abLine);

    block.appendChild(el("label", null, "Options"));
    var optWrap = el("div", null);
    function renderOpts() {
      optWrap.innerHTML = "";
      qd.options.filter(function (o) { return !o._auto; }).forEach(function (od) {
        optWrap.appendChild(optionEditRow(qd, od, function () { qd.options.splice(qd.options.indexOf(od), 1); }, false, ctx));
      });
    }
    renderOpts();
    block.appendChild(optWrap);
    var addOptBtn = el("button", "btn secondary", "+ Add option"); addOptBtn.type = "button"; addOptBtn.style.marginTop = "4px";
    addOptBtn.addEventListener("click", function () { qd.options.push(newOptionDraft("")); renderOpts(); });
    block.appendChild(addOptBtn);
  } else if (qd.question_type === "availability") {
    block.appendChild(el("label", null, "Proposed date/time slots"));
    var slotWrap = el("div", null);
    function renderSlots() {
      slotWrap.innerHTML = "";
      qd.options.forEach(function (od) {
        slotWrap.appendChild(optionEditRow(qd, od, function () { qd.options.splice(qd.options.indexOf(od), 1); }, true, ctx));
      });
    }
    renderSlots();
    block.appendChild(slotWrap);
    var addSlotBtn = el("button", "btn secondary", "+ Add time slot"); addSlotBtn.type = "button"; addSlotBtn.style.marginTop = "4px";
    addSlotBtn.addEventListener("click", function () { qd.options.push(newOptionDraft("")); renderSlots(); });
    block.appendChild(addSlotBtn);
  } else if (qd.question_type === "rating") {
    block.appendChild(el("label", null, "Scale"));
    var scaleRow = document.createElement("div"); scaleRow.style.display = "flex"; scaleRow.style.gap = "8px";
    var minI = document.createElement("input"); minI.type = "number"; minI.value = qd.rating_min || 1;
    minI.addEventListener("input", function () { qd.rating_min = parseInt(minI.value, 10) || 1; });
    var maxI = document.createElement("input"); maxI.type = "number"; maxI.value = qd.rating_max || 5;
    maxI.addEventListener("input", function () { qd.rating_max = parseInt(maxI.value, 10) || 5; });
    scaleRow.appendChild(minI); scaleRow.appendChild(maxI);
    block.appendChild(scaleRow);
  }
  return block;
}
