// The model an agent is running, read from the agent's own status line: the footer its TUI
// draws under the work ("deepseek-v4.1-flash • high" right-aligned under pi's stats, omp's
// "DeepSeek V4.1 Flash ·  high · ~/spaces/demo-app · …"). Herdr's own data says what an
// agent is and how it is doing, not which model it runs, and the stores this panel already
// reads keep no model (omp's agent.db has no per-session messages, its history.db prompts and
// titles only), so the screen is the one place pi and omp both say it.
//
// Only the "model <separator> effort" idiom of a footer is taken, and only from the lines at
// the bottom of the screen: a line that does not read that way gives no model rather than a
// guess, so an agent we cannot read simply shows none.

import { hc } from "herdr";

// The effort words a footer puts after the model (pi's "high", omp's "high").
const EFFORT = /^(none|minimal|low|medium|high|xhigh|max)$/i;
// What the two are separated by: a bullet, a middle dot.
const SEP = /\s*[•·]\s*/;
// How many lines at the bottom of the screen can hold a footer.
const LINES = 8;
// A model's name, not a paragraph: anything longer is a line of prose that happened to end in
// an effort word.
const LONGEST = 48;

// A footer draws an icon or a box glyph before its words: neither is part of the model's name.
const clean = (part) => String(part ?? "")
  .replace(/^[^\p{L}\p{N}]+/u, "")
  .replace(/[^\p{L}\p{N}.)\]]+$/u, "")
  .trim();

// The last field of a footer line: pi puts its stats on the left and the model on the right,
// with a run of spaces between them rather than a dot.
const lastField = (part) => String(part ?? "").split(/\s{2,}/).filter(Boolean).pop() ?? "";

// "DeepSeek V4.1 Flash" or "deepseek-v4.1-flash": words a name is made of, not a sentence.
const named = (name) => !/\s/.test(name) || name.split(/\s+/).every((word) => /^[\p{Lu}\p{N}]/u.test(word));

// The model a piece of a footer names, once its glyphs are gone.
function modelOf(part) {
  const whole = clean(part);
  if (whole.length >= 2 && whole.length <= LONGEST && named(whole)) return whole;
  const field = clean(lastField(part));
  return field.length >= 2 && field.length <= LONGEST && named(field) ? field : "";
}

/** The model and effort a screen's footer names, as "model · effort", or "" when it names none. */
export function modelIn(text) {
  const lines = String(text ?? "").split("\n").filter((line) => line.trim());
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < LINES; i -= 1, seen += 1) {
    const parts = lines[i].split(SEP);
    for (let j = 1; j < parts.length; j += 1) {
      const effort = clean(parts[j]);
      if (!EFFORT.test(effort)) continue;
      const model = modelOf(parts[j - 1]);
      if (model) return `${model} · ${effort.toLowerCase()}`;
    }
  }
  return "";
}

/** The model an agent runs, read from its terminal's footer here; "" for another machine's. */
export async function lastModel(agent) {
  const address = String(agent?.address ?? "");
  // An address that names a machine is a terminal that machine's core holds: nothing to read here.
  if (!address || address.includes("/")) return "";
  try {
    const r = await hc(["read", address, "--lines", String(LINES)]);
    return r.code === 0 ? modelIn(r.stdout) : "";
  } catch {
    return "";
  }
}
