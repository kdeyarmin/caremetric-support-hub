import { NavLink } from "react-router-dom";
import { PenLine } from "lucide-react";
import type { ContentItem, Product } from "../domain";
import { knowledgeCoverage } from "./knowledgeCoverage";
import "./communications.css";

/** Article coverage for every application, so gaps in the shared knowledge base are visible. */
export function KnowledgeCoverage({ products, content, selectedProductId, onSelect, canWrite }: {
  products: Product[]; content: ContentItem[]; selectedProductId: string; onSelect: (productId: string) => void; canWrite: boolean;
}) {
  const coverage = knowledgeCoverage(products, content);
  return <section className="panel knowledge-coverage" aria-label="Knowledge coverage by application">
    <div className="panel-heading"><div><h2>Knowledge coverage by application</h2><p>Published articles you can see for each application. Applications with only shared guidance need their own articles.</p></div></div>
    <div className="knowledge-coverage-grid">{coverage.map(({ product, published, appSpecific, shared }) => <div key={product.id} className={`knowledge-coverage-card${appSpecific === 0 ? " needs-articles" : ""}${selectedProductId === product.id ? " active" : ""}`}>
      <button type="button" aria-pressed={selectedProductId === product.id} onClick={() => onSelect(selectedProductId === product.id ? "all" : product.id)}>
        <strong>{product.name}</strong><span>{published} published · {appSpecific} app-specific · {shared} shared</span>
        {appSpecific === 0 && <small>Needs app-specific articles</small>}
      </button>
      {canWrite && <NavLink className="text-link" to={`/docstudio?product=${encodeURIComponent(product.slug)}`} aria-label={`Write an article for ${product.name}`}><PenLine size={14} aria-hidden="true" /> Write an article</NavLink>}
    </div>)}</div>
  </section>;
}
