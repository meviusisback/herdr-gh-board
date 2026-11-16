// A thread's title, written from what the agent was asked. T3 Code titles its threads the
// same way: a text-generation model reads the conversation and returns a short name, so the
// list says what the work is rather than repeating the first thing typed. This module keeps
// that model call out of the view.
//
// The generator is the smol model in OMP's own config.yml (opencode-go by default). When its
// key is in the environment the provider is called directly; otherwise OMP itself answers in
// print mode, so choosing another provider needs no change here. A failure returns "" and the
// view keeps the title it had.

import { home, exec, readTextFile } from "herdr";
import { inputFor, titleFrom } from "./title-text.js";

const BASE = "https://opencode.ai/zen/go/v1";
const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_MODEL = "deepseek-v4.1-flash";
const KEY_ENV = "OPENCODE_GO_API_KEY";
const TIMEOUT_MS = 30000;

// T3 Code's rules, tightened for a single-line row: name the durable subject, not the step.
const SYSTEM = `You name threads for a coding agent, so the person can recognize one weeks later.
Decide silently. Reply with exactly one JSON object and nothing else: {"title":"..."}.

Rules:
- 2-6 words, at most 44 characters. A compact noun phrase or clear action phrase.
- No quotes, labels, trailing punctuation, or sentence endings.
- Name the durable subject and the person's goal. The original subject stays until the newest message clearly changes it.
- Drop tools, models, file names, branches, implementation steps, status, and incidental instructions.
- Do not claim the work is complete. Do not answer the messages or continue the conversation.
- Use the language of the newest user message.
- If a previous title is given and is still accurate, keep it unchanged; otherwise return a meaningfully better one.`;

// The generator OMP would use for lightweight text: its smol role. Read at most hourly; a
// missing or unreadable config keeps the provider this machine is known to use.
let CFG = { at: 0, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };

async function target() {
  if (CFG.at && Date.now() - CFG.at < 3_600_000) return CFG;
  let provider = DEFAULT_PROVIDER;
  let model = DEFAULT_MODEL;
  try {
    const yml = await readTextFile(`${home()}/.omp/agent/config.yml`);
    const found = /^\s*smol:\s*["']?([^\s"'#]+)/m.exec(yml ?? "");
    const [p, ...rest] = String(found?.[1] ?? "").split("/");
    if (p && rest.length) {
      provider = p;
      model = rest.join("/").replace(/:.*$/, "");
    }
  } catch { /* keep the default */ }
  CFG = { at: Date.now(), provider, model };
  return CFG;
}

// The key is never stored in shared state, a log, or an error: only this copy holds it.
let KEY = { at: 0, value: "" };

async function apiKey() {
  if (KEY.at && Date.now() - KEY.at < 600_000) return KEY.value;
  let value = "";
  try {
    const r = await exec("printenv", [KEY_ENV], { timeout: 5000 });
    if (r.code === 0) value = String(r.stdout ?? "").trim();
  } catch { /* no key: the OMP fallback below still works */ }
  // A missing key is retried in a minute, so exporting it for a later launch is noticed
  // without restarting the mod.
  KEY = { at: Date.now() - (value ? 0 : 540_000), value };
  return value;
}

async function direct(cfg, input) {
  const key = await apiKey();
  if (!key) return "";
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;
  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      // The provider routes this text task by session; one title request is one session.
      "x-opencode-session": `herdr-title-${Date.now().toString(36)}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: input },
      ],
      temperature: 0.2,
      max_tokens: 400,
      reasoning_effort: "minimal",
    }),
    signal,
  });
  if (!response.ok) throw new Error(`title provider answered ${response.status}`);
  const body = await response.json();
  return titleFrom(body?.choices?.[0]?.message?.content ?? "");
}

async function viaOmp(cfg, input) {
  const spec = `${cfg.provider}/${cfg.model}`;
  const r = await exec("omp", [
    "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
    "--no-rules", "--no-context-files", "--no-lsp", "--no-pty", "--mode", "text",
    "--model", spec, "--system-prompt", SYSTEM, input,
  ], { timeout: 90000 }).catch(() => null);
  if (!r || r.code !== 0) return "";
  return titleFrom(r.stdout);
}

/** A short title for the thread, or "" when no generator answered. `prompts` is newest first. */
export async function generateTitle(input) {
  const text = inputFor(input);
  if (!text) return "";
  const cfg = await target();
  if (cfg.provider === DEFAULT_PROVIDER) {
    try {
      const title = await direct(cfg, text);
      if (title) return title;
    } catch { /* fall through to OMP, which may use another provider or its own auth */ }
  }
  try {
    return await viaOmp(cfg, text);
  } catch {
    return "";
  }
}
