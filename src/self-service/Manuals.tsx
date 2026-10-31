import { useMemo, useState } from 'react';
import type { ContentItem, Product } from '../domain';

/** Manuals use the same published, audience-filtered revisions as search and AI retrieval. */
export function Manuals({ products, content }: { products: Product[]; content: ContentItem[] }) {
  const [product, setProduct] = useState('all');
  const [search, setSearch] = useState('');
  const articles = useMemo(() => content.filter(item => item.kind === 'article' && item.status === 'published'
    && (product === 'all' || item.productIds.includes(product))
    && `${item.title} ${item.summary} ${item.body ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => a.title.localeCompare(b.title)), [content, product, search]);
  return <div className="learning-workspace"><header><span className="eyebrow">Knowledge &amp; instructions</span><h1>CareMetric user manuals</h1><p>Setup, feature instructions, troubleshooting, FAQs, and helpful tips from the current published guides.</p></header>
    <div className="panel library-toolbar manuals-toolbar print-hidden"><label>Application<select value={product} onChange={event => setProduct(event.target.value)}><option value="all">All applications</option>{products.filter(item => item.status !== 'retired').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Search instructions<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Setup, password reset, invoices, training…" /></label><button className="button button-secondary" onClick={() => window.print()}>Print / save manual as PDF</button></div>
    {articles.length > 0 && <nav className="panel manual-contents print-hidden" aria-label="Manual contents"><h2>Contents</h2><ol>{articles.map(article => <li key={article.id}><a href={`#manual-${article.id}`}>{article.title}</a></li>)}</ol></nav>}
    {!articles.length && <p>No published guides match this application and search. Try a broader search or open a support request.</p>}
    {articles.map(article => <article className="panel manual-section" id={`manual-${article.id}`} key={article.id}><h2>{article.title}</h2><p>{article.summary}</p><div className="manual-body">{article.body}</div><p className="muted">Revision {article.revision} · {article.locale}</p></article>)}
  </div>;
}
