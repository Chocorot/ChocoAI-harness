// Pure-logic tests for the web UI (no DOM needed). Run: node --test web/test
import assert from "node:assert/strict";
import test from "node:test";
const root = new URL("../js/", import.meta.url).href;
const { renderMarkdown, splitBlocks, inline, esc } = await import(root + "md.js");
const { splitEvents, splitThink } = await import(root + "sse.js");
const { icon, hasIcon, effortIcon } = await import(root + "icons.js");
const { parseUserContent, fmtSize, extOf } = await import(root + "attach.js");

test("html is always escaped", () => {
  const h = renderMarkdown("<script>alert(1)</script> **b** `<i>`");
  assert.ok(!h.includes("<script"));
  assert.ok(h.includes("&lt;script&gt;") && h.includes("<strong>b</strong>") && h.includes("<code>&lt;i&gt;</code>"));
  assert.ok(!inline('[x](javascript:alert(1))').includes("<a"));
  assert.ok(inline("[ok](https://a.b/c?d=1&e=2)").includes('href="https://a.b/c?d=1&amp;e=2"'));
  assert.ok(!inline('"><img src=x onerror=alert(1)>').includes("<img"));
});
test("autolink without breaking existing links", () => {
  const h = inline("see https://example.org/a. and [t](https://x.y)");
  assert.equal((h.match(/<a /g) || []).length, 2);
  assert.ok(h.includes('href="https://example.org/a"'));
});
test("code fences keep blank lines and split correctly", () => {
  const src = "intro\n\n```js\na\n\nb\n```\nafter fence\n\n- one\n- two";
  const b = splitBlocks(src);
  assert.equal(b.length, 4);
  assert.ok(b[1].startsWith("```js") && b[1].includes("a\n\nb"));
  assert.equal(b[2], "after fence");
  const h = renderMarkdown(src);
  assert.ok(h.includes('<span>js</span>') && h.includes("<pre><code>a\n\nb</code></pre>"));
  assert.ok(renderMarkdown("```\nunclosed").includes("unclosed"));  // mid-stream
});
test("lists, ordered start, nesting, headings, quotes, tables", () => {
  assert.ok(renderMarkdown("- a\n- b\n  - c").includes("<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>"));
  assert.ok(renderMarkdown("3. three\n4. four").includes('<ol start="3">'));
  assert.ok(renderMarkdown("1. one\n2. two").includes("<ol><li>one</li><li>two</li></ol>"));
  assert.ok(renderMarkdown("# T\ntext").includes("<h2>T</h2><p>text</p>"));
  assert.ok(renderMarkdown("> q1\n> q2").includes("<blockquote>q1<br>q2</blockquote>"));
  const t = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.ok(t.includes('<div class="tbl"><table>') && t.includes("<th>a</th>") && t.includes("<td>2</td>"));
  assert.ok(renderMarkdown("line1\nline2").includes("<p>line1<br>line2</p>"));
  assert.ok(renderMarkdown("para\n- item").includes("<p>para</p><ul><li>item</li></ul>"));
});
test("emphasis does not eat snake_case or math", () => {
  assert.ok(!inline("use my_var_name here").includes("<em>"));
  assert.ok(inline("a *b* c").includes("<em>b</em>"));
  assert.ok(!inline("2 * 3 * 4").includes("<em>")); // spaces around the star: not emphasis
});
test("sse parsing handles split chunks, comments and garbage", () => {
  let { events, rest } = splitEvents('data: {"t":"text","d":"a"}\n\n: ka\n\ndata: {"t":"te');
  assert.deepEqual(events, [{ t: "text", d: "a" }]);
  ({ events, rest } = splitEvents(rest + 'xt","d":"b"}\n\ndata: not json\n\n'));
  assert.deepEqual(events, [{ t: "text", d: "b" }]);
  assert.equal(rest, "");
});
test("inline <think> split, also with a tag cut in half", () => {
  assert.deepEqual(splitThink("hello"), { think: "", answer: "hello" });
  assert.deepEqual(splitThink("<th"), { think: "", answer: "" });
  assert.deepEqual(splitThink("<think>pondering"), { think: "pondering", answer: "" });
  assert.deepEqual(splitThink("<think>pondering</think>\n\nThe answer"), { think: "pondering", answer: "The answer" });
  assert.deepEqual(splitThink("a <think>x</think>"), { think: "", answer: "a <think>x</think>" });
});
test("icons", () => {
  assert.ok(icon("send").includes("<svg") && hasIcon("send") && !hasIcon("nope"));
  assert.ok(icon("nope").includes("<path"));
});

test("saved user messages: text, documents and photos are told apart again", () => {
  const doc = 'summarise this\n\n<attached_file name="notes.txt" (truncated: 5 of 9 characters)>\nhello\nworld\n</attached_file>\n\n<attached_file name="b.md">\n# x\n</attached_file>';
  assert.deepEqual(parseUserContent(doc), { text: "summarise this", files: ["notes.txt", "b.md"], images: [] });
  const mixed = parseUserContent([{ type: "text", text: "what is this?" }, { type: "image_ref", name: "uploads/p.jpg" }]);
  assert.deepEqual(mixed, { text: "what is this?", files: [], images: ["p.jpg"] });
  assert.deepEqual(parseUserContent("plain"), { text: "plain", files: [], images: [] });
  assert.deepEqual(parseUserContent(null), { text: "", files: [], images: [] });
});
test("sizes and extensions", () => {
  assert.equal(fmtSize(500), "500 B"); assert.equal(fmtSize(2048), "2 KB"); assert.equal(fmtSize(1572864), "1.5 MB");
  assert.equal(extOf("Report.PDF"), ".pdf"); assert.equal(extOf("noext"), ""); assert.equal(extOf("a.b.c.docx"), ".docx");
});

test("effort meter fills as many bars as the level index plus one", () => {
  const filled = (svg) => [...svg.matchAll(/fill-opacity="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(filled(effortIcon(0, 3)), [1, 0.28, 0.28]);
  assert.deepEqual(filled(effortIcon(1, 3)), [1, 1, 0.28]);
  assert.deepEqual(filled(effortIcon(2, 3)), [1, 1, 1]);
  assert.equal((effortIcon(0, 2).match(/<rect/g) || []).length, 2); // fewer levels, fewer bars
  assert.ok(hasIcon("more") && hasIcon("pencil"));
});
