import { Fragment, useEffect, useMemo } from "react";
import { ArrowLeft, FileText } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import type { ContentItem } from "../domain";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown";

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return <>{nodes.map((node, index) => {
    switch (node.type) {
      case "text": return <Fragment key={index}>{node.text}</Fragment>;
      case "code": return <code key={index}>{node.text}</code>;
      case "strong": return <strong key={index}><InlineNodes nodes={node.children} /></strong>;
      case "em": return <em key={index}><InlineNodes nodes={node.children} /></em>;
      case "link": return <a key={index} href={node.href}><InlineNodes nodes={node.children} /></a>;
    }
  })}</>;
}

function BlockNode({ block }: { block: Block }) {
  switch (block.type) {
    case "heading": {
      const Heading = `h${block.level}` as "h2" | "h3" | "h4";
      return <Heading><InlineNodes nodes={block.children} /></Heading>;
    }
    case "paragraph": return <p><InlineNodes nodes={block.children} /></p>;
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return <List>{block.items.map((item, index) => <li key={index}><InlineNodes nodes={item} /></li>)}</List>;
    }
    case "quote": return <blockquote><p><InlineNodes nodes={block.children} /></p></blockquote>;
    case "code": return <pre><code>{block.text}</code></pre>;
    case "rule": return <hr />;
  }
}

/** An article's Markdown as elements. Nothing in it is ever inserted as markup: text stays text and only safe links are links. */
export function MarkdownView({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className="help-article-body">{blocks.map((block, index) => <BlockNode key={index} block={block} />)}</div>;
}

/** One published article, at its own address, for anyone who may read it (a public article for everyone). */
export function HelpArticlePage({ content }: { content: ContentItem[] }) {
  const { key = "" } = useParams();
  const article = content.find((item) => item.contentKey === key && item.kind === "article" && item.status === "published");
  useEffect(() => {
    if (!article) return;
    const previous = document.title;
    document.title = `${article.title} | CareMetric Help Center`;
    return () => { document.title = previous; };
  }, [article]);

  if (!article) {
    return <section className="panel help-article help-article-missing">
      <span className="eyebrow">Help center</span>
      <h1>This article is not available</h1>
      <p>It may have moved, or it may be for signed-in customers only.</p>
      <Link className="text-link" to="/help"><ArrowLeft size={15} aria-hidden="true" /> Back to the help center</Link>
    </section>;
  }
  return <article className="panel help-article">
    <nav className="help-article-crumbs" aria-label="Breadcrumb"><Link to="/help"><ArrowLeft size={15} aria-hidden="true" /> Help center</Link></nav>
    <span className="eyebrow"><FileText size={14} aria-hidden="true" /> Article</span>
    <h1>{article.title}</h1>
    {article.summary && <p className="help-article-summary">{article.summary}</p>}
    <MarkdownView source={article.body ?? ""} />
  </article>;
}
