// A thread title's text, tried outside the app: `bun test mods/spaces-tree/title-text.test.js`.
import { test, expect } from "bun:test";
import { inputFor, threadKey, titleFrom } from "./title-text.js";

test("a reply in the asked shape is the title, not the JSON", () => {
  expect(titleFrom('{"title":"Fix login redirect"}')).toBe("Fix login redirect");
  expect(titleFrom('```json\n{"title":"Fix login redirect"}\n```')).toBe("Fix login redirect");
  expect(titleFrom('Noise before\n{"title":"Fix login redirect"}\nNoise after')).toBe("Fix login redirect");
});

test("a plain reply loses quotes, a label and trailing punctuation", () => {
  expect(titleFrom('Title: "Fix login redirect."')).toBe("Fix login redirect");
  expect(titleFrom("`Remove Alt+Space conflict`")).toBe("Remove Alt+Space conflict");
});

test("nothing worth a row is empty", () => {
  for (const reply of ["", "   ", "{}", '{"title":""}', "untitled", "New thread", "none"]) {
    expect(titleFrom(reply)).toBe("");
  }
});

test("a long title is cut by characters, never mid-surrogate", () => {
  const title = titleFrom(JSON.stringify({ title: "🐛".repeat(80) }));
  expect(Array.from(title)).toHaveLength(60);
  expect(title.endsWith("\u2026")).toBe(true);
});

test("the input is oldest first, with the previous title and the recap", () => {
  const text = inputFor({
    agentName: "OMP",
    folder: "/repo",
    prompts: ["third", "second", "first"],
    recap: "Goal was to fix it",
    previous: "Old title",
  });
  expect(text.indexOf("1. first")).toBeLessThan(text.indexOf("2. second"));
  expect(text.indexOf("2. second")).toBeLessThan(text.indexOf("3. third"));
  expect(text).toContain('Previous title: "Old title"');
  expect(text).toContain("Goal was to fix it");
});

test("a new prompt or session is a new title; an unchanged set is not", () => {
  const a = { session: "omp:1", prompts: ["fix", "add"] };
  const same = { session: "omp:1", prompts: ["fix", "add"] };
  const newer = { session: "omp:1", prompts: ["fix", "add", "test"] };
  const other = { session: "omp:2", prompts: ["fix", "add"] };
  expect(threadKey(same)).toBe(threadKey(a));
  expect(threadKey(newer)).not.toBe(threadKey(a));
  expect(threadKey(other)).not.toBe(threadKey(a));
});

test("control and bidi characters from a model never reach a row", () => {
  expect(titleFrom('{"title":"fix \\u001b[31mthe\\u202e login"}')).toBe("fix [31mthe login");
});
