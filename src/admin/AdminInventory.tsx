import { useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { adminInventory, adminInventoryProducts, filterAdminInventory } from "./inventory";

export function AdminInventory() {
  const [query, setQuery] = useState("");
  const [product, setProduct] = useState("all");
  const matches = filterAdminInventory(adminInventory, query, product);
  const products = adminInventoryProducts.filter((name) => matches.some((item) => item.product === name));

  return <section className="panel admin-inventory" aria-labelledby="admin-inventory-heading">
    <div className="panel-heading">
      <div>
        <h2 id="admin-inventory-heading">All app functions</h2>
        <p>{adminInventory.length} source surfaces across {adminInventoryProducts.length} apps · audited September 10, 2026</p>
      </div>
      <span className="admin-status admin-status-muted">Source inventory</span>
    </div>
    <div className="admin-section-body">
      <p className="admin-explanation">Browse the functions found in each app. These records describe the audited source code; they are not connected controls or a live deployment status. Source links open the exact version reviewed.</p>
      <div className="admin-inventory-filters">
        <label className="admin-search">
          <span className="admin-field-label">Search functions</span>
          <span className="admin-search-input"><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Courses, billing, users, support…" /></span>
        </label>
        <label><span className="admin-field-label">App</span><select value={product} onChange={(event) => setProduct(event.target.value)}><option value="all">All apps</option>{adminInventoryProducts.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      </div>
      <p className="admin-result-count" role="status">{matches.length} matching {matches.length === 1 ? "function" : "functions"}</p>
      {matches.length === 0 ? <div className="empty-state"><Search aria-hidden="true" /><strong>No matching functions</strong><p>Try a different search or select all apps.</p></div> : <div className="admin-inventory-groups">
        {products.map((name) => {
          const items = matches.filter((item) => item.product === name);
          return <details className="admin-inventory-group" key={`${name}:${query}:${product}`} open={Boolean(query.trim()) || product !== "all"}>
            <summary><strong>{name}</strong><span>{items.length} {items.length === 1 ? "function" : "functions"}</span></summary>
            <ul>{items.map((item) => <li key={`${item.sourceFile}:${item.sourceLine}:${item.surface}`}>
              <div className="admin-function-info"><strong>{item.surface}</strong><span>{item.surfaceType}</span><p>{item.auditAvailability}</p></div>
              <a className="text-link" href={item.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`View source for ${item.product} ${item.surface}`}>View source <ExternalLink size={13} aria-hidden="true" /></a>
            </li>)}</ul>
          </details>;
        })}
      </div>}
    </div>
  </section>;
}
