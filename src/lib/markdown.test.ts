import { describe, expect, it } from "vitest";
import { escapeHtml, inlineText, parseInline, parseMarkdown, renderMarkdownHtml, safeHref } from "./markdown";

describe("help article Markdown", () => {
  it("renders the blocks an article uses, with one title per page", () => {
    expect(renderMarkdownHtml("# Title\n\nFirst line\nsame paragraph.\n\n## Section\n\n### Sub\n\n##### Deep\n\n- one\n- two\n  continued\n\n1. first\n2) second\n\n> a quote\n> goes on\n\n---")).toBe([
      "<h2>Title</h2>", "<p>First line same paragraph.</p>", "<h2>Section</h2>", "<h3>Sub</h3>", "<h4>Deep</h4>",
      "<ul><li>one</li><li>two continued</li></ul>", "<ol><li>first</li><li>second</li></ol>", "<blockquote><p>a quote goes on</p></blockquote>", "<hr>",
    ].join("\n"));
    expect(renderMarkdownHtml("- a\n\n- b\n\nAfter")).toBe("<ul><li>a</li><li>b</li></ul>\n<p>After</p>");
    expect(renderMarkdownHtml("```\nline <one>\n  two\n```\nafter")).toBe("<pre><code>line &lt;one&gt;\n  two</code></pre>\n<p>after</p>");
    expect(renderMarkdownHtml("")).toBe("");
  });

  it("renders bold, italic, code and escapes, without italicizing snake_case", () => {
    expect(renderMarkdownHtml("**In short:** some *words* and _more_, `code <b>`, snake_case_name, 2 * 3 and \\*literal\\*."))
      .toBe("<p><strong>In short:</strong> some <em>words</em> and <em>more</em>, <code>code &lt;b&gt;</code>, snake_case_name, 2 * 3 and *literal*.</p>");
    expect(renderMarkdownHtml("*a **b** c*")).toBe("<p><em>a <strong>b</strong> c</em></p>");
    expect(renderMarkdownHtml("**unclosed and *also")).toBe("<p>**unclosed and *also</p>");
  });

  it("never passes markup through: HTML in an article is shown as text", () => {
    const html = renderMarkdownHtml('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n# <b>Title</b>\n\n- <i>item</i> & "quotes" \'too\'');
    expect(html).toBe([
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>", "<p>&lt;img src=x onerror=&quot;alert(2)&quot;&gt;</p>", "<h2>&lt;b&gt;Title&lt;/b&gt;</h2>",
      "<ul><li>&lt;i&gt;item&lt;/i&gt; &amp; &quot;quotes&quot; &#39;too&#39;</li></ul>",
    ].join("\n"));
    expect(html).not.toMatch(/<(?!\/?(?:p|h2|ul|li)>)/);
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  it("keeps a link only to an https address or a path on this site, and escapes its address", () => {
    expect(renderMarkdownHtml("[Rule](https://www.pacodeandbulletin.gov/Display/pacode?file=/x&d=reduce) and [article](/help/articles/pa-fire-drills)"))
      .toBe('<p><a href="https://www.pacodeandbulletin.gov/Display/pacode?file=/x&amp;d=reduce">Rule</a> and <a href="/help/articles/pa-fire-drills">article</a></p>');
    for (const target of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "http://example.com", "//evil.example", "/\\evil", "https://user:pass@example.com/", "mailto:x@example.com", "vbscript:x", " "]) {
      expect(renderMarkdownHtml(`[words](${target})`), target).not.toContain("<a ");
      expect(renderMarkdownHtml(`[words](${target})`), target).toContain("words");
    }
    expect(renderMarkdownHtml('[x](https://example.com/"onmouseover="alert(1))')).toBe('<p><a href="https://example.com/%22onmouseover=%22alert(1">x</a>)</p>');
    expect(safeHref("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(safeHref("/path\"><script>")).toBeNull();
  });

  it("never nests a link inside a link, and reads plain words back out", () => {
    const nodes = parseInline("[outer [inner](https://a.example) text](https://b.example)");
    expect(JSON.stringify(nodes)).not.toMatch(/"link".*"link"/);
    expect(inlineText(parseInline("**In short:** see [the rule](https://example.com) and `code`"))).toBe("In short: see the rule and code");
  });

  it("stays fast and bounded on hostile input", () => {
    const started = Date.now();
    const hostile = "*".repeat(20_000) + "_".repeat(20_000) + "[".repeat(10_000) + "`".repeat(10_000) + "\n- ".repeat(10_000) + "#".repeat(20_000);
    expect(parseMarkdown(hostile.repeat(2)).length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
