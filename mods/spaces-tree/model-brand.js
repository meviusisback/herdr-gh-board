// Which family a model belongs to, and the mark that says so.
//
// Herdr says what an agent is and how it is doing, not which model it runs: the model is only
// written on the agent's own screen, in the footer its TUI draws, and agent-model.js reads it
// from there. What that footer names is a provider's word plus a version ("deepseek-v4.1-flash",
// "DeepSeek V4.1 Flash", "claude-sonnet-4.5"), so the provider's word is what picks the mark.
// Only a provider's own word claims a mark: "o3" or "m2" are too common to. A name no provider
// claims keeps its words and gets the card's fallback chip, never a wrong logo.

export const MARKS = "mods/spaces-tree/models/";

// The providers people run, each with the words that name it and the colour it is known by.
const BRANDS = [
  { match: ["deepseek", "deep-seek"], name: "DeepSeek", icon: `${MARKS}deepseek.svg`, color: "#4d6bfe" },
  { match: ["claude", "anthropic", "sonnet", "opus", "haiku"], name: "Anthropic", icon: `${MARKS}anthropic.svg`, color: "#d97757" },
  { match: ["gpt", "openai", "chatgpt", "codex"], name: "OpenAI", icon: `${MARKS}openai.svg`, color: "#10a37f" },
  { match: ["gemini", "gemma", "google"], name: "Google", icon: `${MARKS}gemini.svg`, color: "#4e8cff" },
  { match: ["qwen", "qwq", "tongyi"], name: "Qwen", icon: `${MARKS}qwen.svg`, color: "#7d5cff" },
  { match: ["kimi", "moonshot"], name: "Kimi", icon: `${MARKS}moonshot.svg`, color: "#16191e" },
  { match: ["glm", "zhipu", "chatglm", "bigmodel"], name: "Zhipu", icon: `${MARKS}zhipu.svg`, color: "#3859ff" },
  { match: ["grok", "xai"], name: "xAI", icon: `${MARKS}xai.svg`, color: "#16191e" },
  { match: ["llama", "meta"], name: "Meta", icon: `${MARKS}meta.svg`, color: "#0866ff" },
  { match: ["mistral", "mixtral", "codestral", "magistral"], name: "Mistral", icon: `${MARKS}mistral.svg`, color: "#fa520f" },
  { match: ["minimax", "hailuo"], name: "MiniMax", icon: `${MARKS}minimax.svg`, color: "#e23f4a" },
  { match: ["cohere", "command-r", "aya"], name: "Cohere", icon: `${MARKS}cohere.svg`, color: "#39594d" },
  { match: ["nvidia", "nemotron"], name: "NVIDIA", icon: `${MARKS}nvidia.svg`, color: "#76b900" },
];

// #rrggbb -> relative luminance (0 black .. 1 white), the sRGB way.
function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex ?? ""));
  if (!m) return 0.5;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** What reads inside a tile of this colour: the glyph's own colour. */
export function inkOn(color) {
  return luminance(color) > 0.55 ? "#0b0b0d" : "#ffffff";
}

/** The brand's colour where it is legible on a card, else null so the card uses its own text
 *  colour: an almost-black mark on a dark theme, an almost-white one on a light theme. */
export function readOn(color, dark) {
  const l = luminance(color);
  return dark ? (l < 0.16 ? null : color) : (l > 0.72 ? null : color);
}

/** The provider a model's name belongs to, or null when its name claims none. */
export function brandOf(model) {
  const text = String(model ?? "").toLowerCase();
  if (text.length < 2) return null;
  for (const brand of BRANDS) {
    if (brand.match.some((word) => text.includes(word))) return brand;
  }
  return null;
}

/** A model's name split where the provider's word ends: what the family is, and its version. */
export function splitModel(model) {
  const whole = String(model ?? "");
  const at = whole.search(/[\s\-_·/]/);
  if (at <= 0) return [whole, ""];
  return [whole.slice(0, at), whole.slice(at).replace(/^[\s\-_·/]+/, "")];
}
