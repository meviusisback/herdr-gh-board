// An issue body is written by anyone: what reaches the renderer is tried here, outside the app.
// `bun test mods/gh-git/issues.test.js`
import { test, expect } from "bun:test";
import { cleanBody } from "./body.js";

test("a body keeps its words and loses the markup that could fetch or run", () => {
  // No picture, in either markdown form: drawing one is a request to someone's server.
  expect(cleanBody("hi ![shot](https://evil/x.png) there")).toBe("hi  there");
  expect(cleanBody("hi ![shot][ref]\n\n[ref]: https://evil/x.png")).toBe("hi");
  // A tag keeps its name and loses every attribute: src, srcset, background, style, on*.
  expect(cleanBody('<td background="https://evil/x.png">a</td>')).toBe("<td>a</td>");
  expect(cleanBody('<img src=x onerror=alert(1)>')).toBe("");
  expect(cleanBody('<a href="javascript:alert(1)">a</a>')).toBe("<a>a</a>");
  expect(cleanBody('<span style="background:url(https://evil/x)">a</span>')).toBe("<span>a</span>");
  // The tag families that carry a whole document go entirely.
  expect(cleanBody("<script>alert(1)</script><iframe src=x></iframe>")).toBe("alert(1)");
  // What a body says plainly is untouched: paragraphs, code, emphasis, a closing tag.
  expect(cleanBody("**bold** and `code`\n\n```\nplain\n```")).toBe("**bold** and `code`\n\n```\nplain\n```");
  expect(cleanBody("</div>")).toBe("</div>");
  // A nested or escaped bracket in the alt text must not keep an image alive: the marker is
  // escaped, so the renderer shows literal text and fetches nothing.
  expect(cleanBody("![a[b]c](https://evil/x.png)")).toBe("\\![a[b]c](https://evil/x.png)");
  expect(cleanBody("![a\\]b](https://evil/x.png)")).toBe("\\![a\\]b](https://evil/x.png)");
  // A tag whose attributes are separated by `/` still loses them.
  expect(cleanBody('<span/style="background:url(https://evil/x)">a</span>')).toBe("<span>a</span>");
});

test("a body is bounded, and its own control characters never reach the screen", () => {
  expect(cleanBody("x".repeat(5000)).length).toBe(4000);
  expect(cleanBody("x".repeat(5000), 20000).length).toBe(5000);
  expect(cleanBody("a\u202eb\u0000c")).toBe("abc");
});
