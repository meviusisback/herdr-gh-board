// The pure part of a thread title: what a model's reply becomes on a row, and the key that
// says whether a title still describes the prompts it was written from. No host calls, so
// `bun test mods/spaces-tree/title-text.test.js` can exercise it outside the app.

const clip = (value, chars) => {
  const text = String(value ?? "").trim();
  return text.length > chars ? text.slice(0, chars - 1) + "\u2026" : text;
};

// A model reads prompts that anyone can write and answers with text: control and bidi
// codepoints never reach a row, a tooltip or shared state.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** The model's input: the newest prompts, oldest first, with the agent, folder, previous
 *  title and recap as context. */
export function inputFor({ agentName, folder, prompts, recap, previous }) {
  const messages = (prompts ?? []).slice(0, 8).reverse()
    .map((prompt, index) => `${index + 1}. ${clip(prompt, 1400)}`)
    .join("\n");
  return [
    `Agent: ${agentName || "coding agent"}`,
    folder ? `Folder: ${folder}` : "",
    previous ? `Previous title: ${JSON.stringify(clip(previous, 90))}` : "",
    recap ? `Agent's latest progress note: ${clip(recap, 800)}` : "",
    "User messages, oldest first:",
    messages,
  ].filter(Boolean).join("\n");
}

/** A title from whatever the model replied: its JSON when it followed the shape, else its
 *  last readable line. Returns "" when there is nothing a row should show. */
export function titleFrom(raw) {
  let text = String(raw ?? "").trim();
  if (!text) return "";
  const json = text.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const value = JSON.parse(json[0]);
      if (value && typeof value === "object") text = String(value.title ?? value.name ?? "");
    } catch { /* not JSON: fall back to the text itself */ }
  }
  text = text
    .replace(UNSAFE, "")
    .replace(/```[a-z]*|```/gi, "")
    .replace(/^\s*title\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "")
    .replace(/[.;:,!?\u2026]+$/g, "")
    .trim();
  if (!text || /^(untitled|new thread|thread title|title|none)$/i.test(text)) return "";
  const chars = Array.from(text);
  return chars.length > 60 ? chars.slice(0, 59).join("").trimEnd() + "\u2026" : text;
}

/** A compact key for the conversation state a title was written from. The newest prompt and
 *  the count are enough: older prompts do not change, and a new session starts over. */
export function threadKey(thread) {
  const prompts = thread?.prompts ?? [];
  const last = String(prompts[0] ?? "");
  let hash = 2166136261;
  for (let i = 0; i < last.length; i += 1) {
    hash ^= last.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${thread?.session ?? ""}:${prompts.length}:${(hash >>> 0).toString(36)}:${last.length}`;
}
