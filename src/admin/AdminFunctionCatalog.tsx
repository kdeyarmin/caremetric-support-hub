import {useState} from 'react';
import {Link} from 'react-router-dom';
import type {PortfolioCapabilities,PortfolioProduct} from '../../supabase/functions/_shared/portfolioProtocol';
import {adminRegistry} from '../../supabase/functions/_shared/adminRegistry';
import {functionAvailable,searchFunctions} from './functionCatalog';
import type {AdminView} from './functionCatalog';

export function AdminFunctionCatalog({product,capabilities,onNavigate}:{product:PortfolioProduct;capabilities:PortfolioCapabilities|null;onNavigate:(view:AdminView)=>void}){
  const [query,setQuery]=useState('');
  const functions=searchFunctions(query);
  return <section className="panel admin-inventory" aria-labelledby="current-functions-heading">
    <div className="panel-heading"><div><h2 id="current-functions-heading">All app functions</h2><p>Controls for {adminRegistry[product].name} and shared CareMetric workspaces.</p></div></div>
    <div className="admin-section-body">
      <h3>Shared workspaces</h3><div className="admin-quick-links"><Link to="/library">Courses, creation and distribution</Link><Link to="/docstudio">Create learning videos</Link><Link to="/imports/docstudio">Review material imports</Link><Link to="/cases">Support cases</Link><Link to="/knowledge">Knowledge articles</Link><Link to="/products">Products and support contacts</Link><Link to="/integration">Connections and customer onboarding</Link><Link to="/security">Account security</Link></div>
      <p>Each workspace checks its current permissions and configuration when opened.</p>
      <h3>{adminRegistry[product].name} controls</h3>
      <label className="admin-search"><span className="admin-field-label">Find a control</span><input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Billing, courses, access, jobs…"/></label>
      <p role="status">{functions.length} matching controls. {capabilities?'Availability reflects the selected app’s latest connection check.':'The app connection is not verified; shared workspaces remain accessible.'}</p>
      <ul className="admin-function-list">{functions.map(item=>{
        const available=functionAvailable(item,product,capabilities);
        return <li key={item.id}><div><strong>{item.title}</strong><p>{item.description}</p></div><div>
          {available?<button className="button button-secondary button-small" type="button" onClick={()=>onNavigate(item.view)} aria-label={`Open ${item.title}`}>Open control</button>:<span className="admin-status admin-status-muted">{item.carebaseOnly&&product!=='carebase'?'CareBase only':capabilities?'Not connected for this app':'Connection not verified'}</span>}
        </div></li>;
      })}</ul>
      {!functions.length&&<p>No matching controls. Try another search.</p>}
    </div>
  </section>;
}
