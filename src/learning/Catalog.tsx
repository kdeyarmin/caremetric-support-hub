import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { resolveProductSlug, type ContentItem, type Product } from "../domain";
import { config } from "../lib/config";
import { courseLaunchUrl } from "../security/courseLaunch";
import { learningApi } from "./api";

/** Only platform administrators author courses, so only they get the link to the authoring library. */
export function LearningCatalog({ products, legacyContent, canAuthor = false }: { products: Product[]; legacyContent: ContentItem[]; canAuthor?: boolean }) {
  const [params] = useSearchParams();
  const [central, setCentral] = useState<Awaited<ReturnType<typeof learningApi.catalog>>>([]);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  useEffect(() => { let active = true; void learningApi.catalog().then(rows => { if (active) { setCentral(rows); setLoaded(true); setError(""); } }, caught => { if (active) setError(caught instanceof Error ? caught.message : "Course catalog could not load."); }); return () => { active = false; }; }, [attempt]);
  const requested = params.get("product")?.toLowerCase();
  const product = products.find(p => p.slug === resolveProductSlug(requested));
  const courses = useMemo(() => [
    ...central.map(c => ({ id: c.itemId, title: c.title, summary: c.summary ?? "", category: c.category ?? "", duration: c.durationMinutes, productIds: c.productIds, central: true, legacyUrl: null as string | null })),
    ...legacyContent.filter(c => c.kind === "course" && c.status === "published" && !central.some(row => row.itemId === c.id)).map(c => ({ id: c.id, title: c.title, summary: c.summary, category: c.contentCategory ?? "", duration: c.courseDurationMinutes, productIds: c.productIds, central: c.sourceSystem === "support_hub" && courseLaunchUrl(c, undefined) !== null, legacyUrl: courseLaunchUrl(c, config.pennTrainBaseUrl) })),
  ].filter(c => !product || c.productIds.includes(product.id)).sort((a,b) => a.title.localeCompare(b.title)), [central, legacyContent, product]);
  const categories = Array.from(new Set(courses.map(c => c.category).filter(Boolean))).sort();
  const activeCategory = categories.includes(category) ? category : "";
  const filtered = courses.filter(c => (!activeCategory || c.category === activeCategory) && `${c.title} ${c.summary} ${c.category}`.toLowerCase().includes(search.toLowerCase().trim()));
  return <div className="learning-workspace"><nav className="learning-links"><Link to="/learn/my">My learning</Link>{canAuthor && <Link to="/library">Create and manage courses</Link>}</nav><header><p className="eyebrow">CareMetric learning library</p><h1>{product ? `Training for ${product.name}` : "Learn across CareMetric"}</h1><p>One place for courses, lessons, quizzes, and completion records.</p></header>{error && <p role="alert" className="learning-error">{error} <button onClick={() => { setError(""); setLoaded(false); setAttempt(value => value + 1); }}>Retry catalog</button></p>}{!loaded && !error && <p role="status">Loading course catalog…</p>}<section className="learning-toolbar panel"><label className="search-box large"><input aria-label="Search learning library" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search courses and topics" /></label><select aria-label="Filter courses by category" value={activeCategory} onChange={e => setCategory(e.target.value)}><option value="">All categories</option>{categories.map(c => <option key={c}>{c}</option>)}</select><span className="learning-result-count">{filtered.length} course{filtered.length === 1 ? "" : "s"}</span></section><section className="learning-grid">{filtered.map(course => <article className="learning-card" key={course.id}><span className="learning-category">{course.category || "CareMetric training"}</span><h2>{course.title}</h2><p>{course.summary}</p><div className="learning-card-meta">{course.duration && <span>{course.duration} minutes</span>}<span>{course.productIds.length} products</span></div>{course.central ? <Link className="button button-primary" to={`/learn/courses/${course.id}`}>Open course</Link> : <><small>This course is awaiting transfer to the Hub.</small>{course.legacyUrl ? <a className="button button-secondary" href={course.legacyUrl} target="_blank" rel="noreferrer">Open existing course</a> : <span className="action-unavailable">Course unavailable</span>}</>}</article>)}</section>{loaded && !error && !filtered.length && <p>No courses match your search.</p>}</div>;
}
