// Planning the menu's live test: what to run for a folder, and where the server says it
// listens. No herdr imports, so it can be tried outside the app.

/** package.json scripts worth starting, best first. */
const SCRIPTS = ["dev", "start", "serve", "preview"];

// A script worth starting, and only a name: after the word may come the separators real projects
// use (`dev:x`, `preview-2`) and nothing a shell would read twice. The rest of the name is the
// repository's text — `dev-;curl … | sh` is a legal package.json key — so the picker refuses it.
const SCRIPT = /^(dev|start|serve|preview)([:.\-][A-Za-z0-9:._\-]{0,40})?$/i;

/** The script a package.json's text offers, or why it offers none. */
export function planFromPackage(text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return { error: "package.json is not valid JSON" }; }
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const usable = (name) => SCRIPT.test(name) && typeof scripts[name] === "string" && scripts[name].trim() !== "";
  const exact = SCRIPTS.find(usable);
  const loose = Object.keys(scripts).find(usable);
  const script = exact ?? loose;
  return script ? { script } : { error: "no dev/start script in package.json" };
}

/** The package manager, from the lock files a folder has. */
export function managerFrom(lockfiles) {
  if (lockfiles?.pnpm) return "pnpm";
  if (lockfiles?.bun) return "bun";
  if (lockfiles?.yarn) return "yarn";
  return "npm";
}

// A word a shell reads as itself; anything else is quoted, so a name can never end the command
// and start one of its own.
const SHELL_WORD = /^[A-Za-z0-9._:@%+=,/\-]+$/;
const quote = (word) => (SHELL_WORD.test(word) ? word : `'${String(word).replace(/'/g, "'\\''")}'`);

/** How to run a script with that package manager, as one line to type into a shell. */
export function commandFor(manager, script) {
  return `${manager} run ${quote(script)}`;
}

/** The same command as arguments: the name is one argv element, so no shell re-reads it. */
export function scriptArgs(manager, script) {
  return ["bash", "-lc", 'exec "$@"', "sh", manager, "run", script];
}

// What servers colour their output with; a URL split by an escape code would be misread.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s"'`<>)\]]*)?/g;

/** Every local URL a server printed, in the order it printed them, once each. A dev script
 *  may run an API beside its web app, so what to open is chosen from all of them, not one. */
export function findUrls(text) {
  const clean = String(text ?? "").replace(ANSI, "").replace(/\r/g, "");
  const seen = [];
  for (const raw of clean.match(URL) ?? []) {
    const url = raw.replace(/[.,;:]+$/, "").replace("://0.0.0.0", "://localhost");
    if (!seen.includes(url)) seen.push(url);
  }
  return seen;
}

/** A URL this mod may open or probe: the app's own loopback server, http(s) only. */
export function localPage(url) {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s"'`<>)\]]*)?$/i
    .test(String(url ?? "").trim());
}

/** A terminal address as `hc` names one: no space, no leading dash, nothing a parser re-reads. */
export function isAddress(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(String(value ?? ""));
}

/** The output ends at the shell's prompt: whatever ran in that terminal is over, so no more
 *  URLs are coming. A tab being typed into shows its command echoed after the old prompt, so
 *  this is false again as soon as the new command runs. */
export function shellIdle(text) {
  const lines = String(text ?? "").replace(ANSI, "").replace(/\r/g, "").split("\n")
    .map((line) => line.trim()).filter((line) => line !== "");
  return lines.length > 0 && PROMPT.test(lines[lines.length - 1]);
}

// A start that failed says why in a line of its own: the port it could not bind, the module
// it could not find, the exit code. The stack around it says nothing to a person.
const PROBLEM = /error|in use|eaddrinuse|eacces|refused|failed|cannot|could not|denied|not found|exited with code/i;
// A shell's prompt came back: the command is over and its output is done talking. Short and
// ending in one of the prompt characters every shell uses, after starship's colour is gone.
const PROMPT = /^.{0,48}?[$#%>]\s*$/;

/** Why a start failed, from what its terminal shows: the last `max` lines that name a
 *  problem. "" when the output names none: a server that is merely slow, or a command that
 *  ended quietly, is better reported by what did not answer than by its harmless log. */
export function reasonFrom(text, max = 2) {
  const lines = String(text ?? "").replace(ANSI, "").replace(/\r/g, "")
    .split("\n").map((line) => line.trim())
    .filter((line) => line !== "" && !PROMPT.test(line) && !line.startsWith("$ ") && PROBLEM.test(line));
  return lines.slice(-max).join(" \u00b7 ");
}
