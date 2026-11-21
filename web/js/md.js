// Small markdown renderer. Escapes first, so model/user text can never inject HTML. Works block by block so a
// streaming reply only re-renders its last (unfinished) block.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^(https?:\/\/|mailto:)/i.test(u) ? u : null);
const FENCE = /^\s*```/;

export function inline(text) {
  const codes = [];
  let t = esc(text).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const u = safeUrl(url.replace(/&amp;/g, "&"));
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
  });
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (m, pre, url) =>
    `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  t = t.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (m, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]*?[^*\s])\*(?!\*)/g, "$1<em>$2</em>")  // no space just inside the marks: "2 * 3 * 4" is not italic
    .replace(/(^|[^_\w])_(?!\s)([^_\n]*?[^_\s])_(?![_\w])/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

// Blocks are separated by blank lines; a fenced code block stays in one piece even if it has blank lines.
export function splitBlocks(src) {
  const blocks = [];
  let cur = [], fence = false;
  const flush = () => { if (cur.length) blocks.push(cur.join("\n")); cur = []; };
  for (const line of src.split("\n")) {
    if (FENCE.test(line)) {
      if (!fence) { flush(); fence = true; cur.push(line); } else { cur.push(line); flush(); fence = false; }
    } else if (!fence && line.trim() === "") flush();
    else cur.push(line);
  }
  flush();
  return blocks;
}

const LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || "");
const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const startsBlock = (l, next) => /^(#{1,4})\s/.test(l) || LI.test(l) || /^>\s?/.test(l) || /^\s*([-*_])\1{2,}\s*$/.test(l) || (l.includes("|") && isTableSep(next));

export function renderBlock(b) {
  const lines = b.split("\n");
  if (FENCE.test(lines[0])) {
    const lang = lines[0].replace(/^\s*```/, "").trim().split(/\s+/)[0] || "";
    const body = lines.slice(1);
    if (body.length && FENCE.test(body[body.length - 1])) body.pop();
    return `<div class="code"><div class="code-h"><span>${esc(lang)}</span><button class="copy" type="button" data-copy>Copy</button></div><pre><code>${esc(body.join("\n"))}</code></pre></div>`;
  }
  let html = "", i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { html += `<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`; i++; }
    else if (/^\s*([-*_])\1{2,}\s*$/.test(l)) { html += "<hr>"; i++; }
    else if (/^>\s?/.test(l)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      html += `<blockquote>${q.map(inline).join("<br>")}</blockquote>`;
    } else if (LI.test(l)) {
      const items = [];
      while (i < lines.length && (m = LI.exec(lines[i]))) { items.push({ sub: m[1].length >= 2, ord: /\d/.test(m[2]), n: parseInt(m[2], 10), text: m[3] }); i++; }
      const ordered = !items[0].sub && items[0].ord;
      let out = "";
      for (let k = 0; k < items.length; k++) {
        if (items[k].sub && k) continue;
        const subs = [];
        for (let j = k + 1; j < items.length && items[j].sub; j++) subs.push(items[j]);
        out += `<li>${inline(items[k].text)}${subs.length ? `<ul>${subs.map((s) => `<li>${inline(s.text)}</li>`).join("")}</ul>` : ""}</li>`;
      }
      html += ordered ? `<ol${items[0].n > 1 ? ` start="${items[0].n}"` : ""}>${out}</ol>` : `<ul>${out}</ul>`;
    } else if (l.includes("|") && isTableSep(lines[i + 1])) {
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) rows.push(cells(lines[i++]));
      html += `<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    } else {
      const p = [];
      while (i < lines.length && (p.length === 0 || !startsBlock(lines[i], lines[i + 1]))) p.push(lines[i++]);
      html += `<p>${p.map(inline).join("<br>")}</p>`;
    }
  }
  return html;
}

export const renderMarkdown = (src) => splitBlocks(src).map(renderBlock).join("");
