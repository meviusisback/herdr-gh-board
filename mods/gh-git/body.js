// What of an issue or pull-request body reaches the renderer. It is written by anyone, so the
// markup that could fetch or run something is not passed on. No app imports, so it can be
// tried outside the app: `bun test mods/gh-git/issues.test.js`.

/** The most markdown one render parses: a comment, a card. */
export const COMMENT_BODY = 2000;

/** A card that scrolls still has to end somewhere: the whole body, up to this. */
export const CARD_BODY = 20000;

export function cleanBody(value, limit = 4000) {
  // Only this much can ever be shown: cutting first means a hostile body cannot cost more than
  // the text it may put on screen (the scans below run to the end of what they are given).
  const input = String(value ?? "").slice(0, limit + 4096);
  return input
    // Control characters (C0, DEL and C1), except the newline and tab that carry the text's own
    // paragraphs, and the bidi/format codepoints that could reorder it.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    // Attributes are where a fetch or a handler lives (src, srcset, background, poster, style,
    // on*…): a tag keeps its name and loses everything after it. `/` separates attributes too.
    .replace(/<(\/?)([a-z][a-z0-9:-]*)(?:[\s/][^>]*)?>/gi, "<$1$2>")
    // Both image forms, then the reference definitions left behind: a picture, wherever its
    // URL sits, is a request to someone's server the moment it is drawn.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    // What is left of an image marker — alt text nested in brackets, an escaped bracket — is
    // escaped, so no bracket shape can still start an image in the renderer.
    .replace(/!\[/g, "\\![")
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<\/?(script|style|iframe|object|embed|svg|link|meta|picture|source|video|audio|track|base|form|input)\b[^>]*>/gi, "")
    .slice(0, limit)
    .trim();
}
