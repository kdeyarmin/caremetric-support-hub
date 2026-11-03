/**
 * The help center's Markdown, read the same way by the Hub server (which renders public articles to HTML for crawlers and the
 * first paint) and by the app (which renders the same article as React elements). It parses a small, fixed subset into a tree:
 * headings, paragraphs, bulleted and numbered lists, block quotes, code blocks and rules; bold, italic, inline code and links.
 *
 * Nothing in the source is ever passed through as markup. HTML in an article is text, shown as written; a link is kept only
 * when its address is https (without credentials) or a path on this site, and otherwise its words are shown without a link.
 * The HTML renderer escapes every character that could start markup, in text and in attributes alike. The parser has no
 * backtracking regular expressions and a fixed nesting depth, and the source is cut to a fixed length first, so no article can
 * make it slow.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: 2 | 3 | 4; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "rule" };

const sourceLimit = 100_000;
const maxDepth = 4;
// How far ahead a closing mark is looked for. A mark with none that near is text, so no input makes a scan quadratic.
const reach = { code: 400, label: 300, address: 2_048, emphasis: 400 };
/** The first `needle` in `text` after `from`, within `span` characters, or -1. */
const near = (text: string, needle: string, from: number, span: number) => {
  const found = text.slice(from, from + span).indexOf(needle);
  return found === -1 ? -1 : from + found;
};

/** An address an article may link to: https without credentials, or a path on this site. Null for anything else. */
export function safeHref(value: string): string | null {
  const address = value.trim();
  if (/^\/(?![/\\])[^\s\\<>"']*$/.test(address)) return address;
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return url.href;
}

const escapable = new Set("\\`*_{}[]()#+-.!<>|~".split(""));
const alnum = /[A-Za-z0-9]/;

/** Where the closing `marker` of an emphasis whose words start at `from` is (within reach), or -1. */
function closing(text: string, marker: string, from: number): number {
  const window = text.slice(0, from + reach.emphasis);
  for (let index = window.indexOf(marker, from); index !== -1; index = window.indexOf(marker, index + 1)) {
    // Empty, or after a space: not a closing marker. A single marker beside another is half of a double one.
    if (index === from || /\s/.test(text[index - 1])) continue;
    if (marker.length === 1 && (text[index + 1] === marker || text[index - 1] === marker)) continue;
    if (marker[0] === "_" && alnum.test(text[index + marker.length] ?? "")) continue;
    return index;
  }
  return -1;
}

/** Inline Markdown as a tree. `links` is false inside a link's own words, so links never nest. */
export function parseInline(text: string, depth = 0, links = true): Inline[] {
  const nodes: Inline[] = [];
  let buffer = "";
  const flush = () => { if (buffer) { nodes.push({ type: "text", text: buffer }); buffer = ""; } };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\" && escapable.has(text[index + 1] ?? "")) { buffer += text[index + 1]; index += 2; continue; }
    if (char === "`") {
      const end = near(text, "`", index + 1, reach.code);
      if (end > index + 1) { flush(); nodes.push({ type: "code", text: text.slice(index + 1, end) }); index = end + 1; continue; }
    }
    if (char === "[" && depth < maxDepth) {
      const close = near(text, "]", index + 1, reach.label);
      if (close > index + 1 && text[close + 1] === "(") {
        const end = near(text, ")", close + 2, reach.address);
        if (end !== -1) {
          const target = text.slice(close + 2, end).trim().replace(/^<([^<>]*)>$/, "$1").split(/\s+/)[0] ?? "";
          const words = parseInline(text.slice(index + 1, close), depth + 1, false);
          const href = links ? safeHref(target) : null;
          flush();
          if (href) nodes.push({ type: "link", href, children: words }); else nodes.push(...words);
          index = end + 1;
          continue;
        }
      }
    }
    if ((char === "*" || char === "_") && depth < maxDepth) {
      const double = text[index + 1] === char;
      const marker = double ? char + char : char;
      const start = index + marker.length;
      const opens = start < text.length && !/\s/.test(text[start]) && (char === "*" || !alnum.test(text[index - 1] ?? ""));
      const end = opens ? closing(text, marker, start) : -1;
      if (end > start) {
        flush();
        nodes.push({ type: double ? "strong" : "em", children: parseInline(text.slice(start, end), depth + 1, links) });
        index = end + marker.length;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return nodes;
}

const fence = /^\s{0,3}(`{3,}|~{3,})/;
const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const rule = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const quote = /^\s{0,3}>\s?(.*)$/;
const bullet = /^\s{0,3}[-*+]\s+(.*)$/;
const numbered = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const startsBlock = (line: string) => fence.test(line) || heading.test(line) || rule.test(line) || quote.test(line) || bullet.test(line) || numbered.test(line);

/** Block Markdown as a tree. A top-level heading becomes a section heading: the page's own title is its only top-level heading. */
export function parseMarkdown(source: string): Block[] {
  const lines = String(source ?? "").slice(0, sourceLimit).replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const opened = fence.exec(line);
    if (opened) {
      const marker = opened[1];
      const body: string[] = [];
      index += 1;
      const closes = (candidate: string) => { const match = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(candidate); return Boolean(match && match[1][0] === marker[0] && match[1].length >= marker.length); };
      while (index < lines.length && !closes(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const titled = heading.exec(line);
    if (titled) {
      const level = Math.min(Math.max(titled[1].length, 2), 4) as 2 | 3 | 4;
      blocks.push({ type: "heading", level, children: parseInline(titled[2]) });
      index += 1;
      continue;
    }
    if (rule.test(line)) { blocks.push({ type: "rule" }); index += 1; continue; }
    if (quote.test(line)) {
      const parts: string[] = [];
      while (index < lines.length && quote.test(lines[index])) { parts.push(quote.exec(lines[index])![1]); index += 1; }
      blocks.push({ type: "quote", children: parseInline(parts.join(" ").trim()) });
      continue;
    }
    const ordered = numbered.test(line);
    if (ordered || bullet.test(line)) {
      const pattern = ordered ? numbered : bullet;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index];
        const item = pattern.exec(current);
        if (item) { items.push(item[1]); index += 1; continue; }
        // A line indented under an item continues it; a blank line ends the list unless the next item follows.
        if (current.trim() && /^\s{2,}\S/.test(current) && !startsBlock(current) && items.length) { items[items.length - 1] += ` ${current.trim()}`; index += 1; continue; }
        if (!current.trim() && index + 1 < lines.length && pattern.test(lines[index + 1])) { index += 1; continue; }
        break;
      }
      blocks.push({ type: "list", ordered, items: items.map(item => parseInline(item.trim())) });
      continue;
    }
    const parts: string[] = [];
    while (index < lines.length && lines[index].trim() && (parts.length === 0 || !startsBlock(lines[index]))) { parts.push(lines[index].trim()); index += 1; }
    blocks.push({ type: "paragraph", children: parseInline(parts.join(" ")) });
  }
  return blocks;
}

/** Text made safe for HTML content and for a quoted attribute value. */
export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);
}

export function renderInlineHtml(nodes: Inline[]): string {
  return nodes.map(node => {
    switch (node.type) {
      case "text": return escapeHtml(node.text);
      case "code": return `<code>${escapeHtml(node.text)}</code>`;
      case "strong": return `<strong>${renderInlineHtml(node.children)}</strong>`;
      case "em": return `<em>${renderInlineHtml(node.children)}</em>`;
      case "link": return `<a href="${escapeHtml(node.href)}">${renderInlineHtml(node.children)}</a>`;
    }
  }).join("");
}

/** Markdown to HTML in which every piece of the source is escaped text. */
export function renderMarkdownHtml(source: string): string {
  return parseMarkdown(source).map(block => {
    switch (block.type) {
      case "heading": return `<h${block.level}>${renderInlineHtml(block.children)}</h${block.level}>`;
      case "paragraph": return `<p>${renderInlineHtml(block.children)}</p>`;
      case "list": return `<${block.ordered ? "ol" : "ul"}>${block.items.map(item => `<li>${renderInlineHtml(item)}</li>`).join("")}</${block.ordered ? "ol" : "ul"}>`;
      case "quote": return `<blockquote><p>${renderInlineHtml(block.children)}</p></blockquote>`;
      case "code": return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
      case "rule": return "<hr>";
    }
  }).join("\n");
}

/** The article's words without any Markdown, for places that take plain text. */
export function inlineText(nodes: Inline[]): string {
  return nodes.map(node => (node.type === "text" || node.type === "code" ? node.text : inlineText(node.children))).join("");
}
