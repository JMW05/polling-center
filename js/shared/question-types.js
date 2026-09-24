import { el } from "./helpers.js";
import { fmtDateTime, fmtTimeOnly } from "./timezone.js";

export function optionLabelFull(o, tz) {
  if (o.slot_start) {
    var s = fmtDateTime(o.slot_start, tz);
    if (o.slot_end) s += " – " + fmtTimeOnly(o.slot_end, tz);
    return s;
  }
  return o.label;
}

export function questionField(q, answerGetters, tz) {
  var wrap = el("div", null);
  wrap.appendChild(el("label", null, q.prompt + (q.required ? " *" : " (optional)")));

  if (q.question_type === "availability" || q.question_type === "multi_select" ||
      (q.question_type === "single_select" && (q.max_selections || 1) > 1)) {
    var isMulti = q.question_type !== "single_select";
    var checks = [];
    var writeInBox = null;
    q.options.slice().sort(function (a, b) { return a.order_index - b.order_index; }).forEach(function (o) {
      var row = el("label", "option-row");
      var input = document.createElement("input");
      input.type = isMulti ? "checkbox" : "radio";
      input.name = q.id; input.value = o.id;
      row.appendChild(input);
      row.appendChild(el("span", "txt", optionLabelFull(o, tz)));
      wrap.appendChild(row);
      checks.push({ input: input, opt: o });
      if (o.is_write_in) {
        input.addEventListener("change", function () { writeInBox.style.display = input.checked ? "block" : "none"; });
      }
    });
    if (q.allow_write_in) {
      writeInBox = document.createElement("input");
      writeInBox.type = "text";
      writeInBox.placeholder = "Write-in name";
      writeInBox.style.display = "none";
      writeInBox.style.marginTop = "6px";
      wrap.appendChild(writeInBox);
    }
    answerGetters.push(function () {
      var picked = checks.filter(function (c) { return c.input.checked; });
      if (q.max_selections && picked.length > q.max_selections) {
        throw new Error("Select up to " + q.max_selections + " for “" + q.prompt + "”.");
      }
      var ans = { question_id: q.id, option_ids: picked.map(function (c) { return c.opt.id; }) };
      if (writeInBox && picked.some(function (c) { return c.opt.is_write_in; })) ans.text_answer = writeInBox.value.trim();
      return ans;
    });
  } else if (q.question_type === "single_select" || q.question_type === "yesno") {
    // Server-side (save_poll_draft) always creates real option rows for
    // Yes/No questions, so this renders exactly like any other
    // single-select question — no synthetic client-side option ids.
    var opts = q.options.slice().sort(function (a, b) { return a.order_index - b.order_index; });
    var radios = [];
    opts.forEach(function (o) {
      var row = el("label", "option-row");
      var input = document.createElement("input");
      input.type = "radio"; input.name = q.id; input.value = o.id;
      row.appendChild(input);
      row.appendChild(el("span", "txt", optionLabelFull(o, tz)));
      wrap.appendChild(row);
      radios.push({ input: input, opt: o });
    });
    answerGetters.push(function () {
      var picked = radios.find(function (r) { return r.input.checked; });
      if (!picked) { if (q.required) throw new Error("Answer “" + q.prompt + "”."); return { question_id: q.id, option_ids: [] }; }
      return { question_id: q.id, option_ids: [picked.opt.id] };
    });
  } else if (q.question_type === "rating") {
    var row2 = el("div", "type-choice");
    var min = q.rating_min || 1, max = q.rating_max || 5;
    var ratingRadios = [];
    for (var i = min; i <= max; i++) {
      (function (val) {
        var lbl = document.createElement("label");
        var inp = document.createElement("input");
        inp.type = "radio"; inp.name = q.id; inp.value = val;
        lbl.appendChild(inp);
        var span = document.createElement("span"); span.textContent = String(val);
        lbl.appendChild(span);
        row2.appendChild(lbl);
        ratingRadios.push({ input: inp, val: val });
      })(i);
    }
    wrap.appendChild(row2);
    answerGetters.push(function () {
      var picked = ratingRadios.find(function (r) { return r.input.checked; });
      if (!picked) { if (q.required) throw new Error("Rate “" + q.prompt + "”."); return { question_id: q.id }; }
      return { question_id: q.id, rating_value: picked.val };
    });
  } else if (q.question_type === "text") {
    var ta = document.createElement("textarea");
    wrap.appendChild(ta);
    answerGetters.push(function () {
      if (q.required && !ta.value.trim()) throw new Error("Answer “" + q.prompt + "”.");
      return { question_id: q.id, text_answer: ta.value.trim() };
    });
  }
  return wrap;
}
