import {useId} from 'react';
import {Link} from 'react-router-dom';

const workspaces = [
  {to:'/phone-numbers',label:'Phone numbers and routing'},
  {to:'/phone',label:'AI phone inbox'},
  {to:'/cases',label:'Support cases'},
  {to:'/knowledge',label:'Knowledge articles'},
  {to:'/library',label:'Courses, creation and distribution'},
  {to:'/docstudio',label:'Create learning videos'},
  {to:'/imports/docstudio',label:'Review material imports'},
  {to:'/products',label:'Products and support contacts'},
  {to:'/integration',label:'Connections and customer onboarding'},
  {to:'/security',label:'Account security'},
  {to:'/overview',label:'Support overview'},
  {to:'/admin/portfolio',label:'Portfolio rollup'},
  {to:'/admin/go-live-readiness',label:'AI go-live readiness'},
] as const;

export function SharedAdminWorkspaces(){
  const headingId=useId();
  return <section className="panel shared-admin-workspaces" aria-labelledby={headingId}>
    <h3 id={headingId}>Shared workspaces</h3>
    <nav className="admin-quick-links shared-admin-links" aria-label="Shared owner workspaces">
      {workspaces.map(workspace=><Link key={workspace.to} to={workspace.to}>{workspace.label}</Link>)}
    </nav>
    <p>Open these workspaces here in the Hub using your current sign-in. Each workspace checks its current permissions and configuration when opened.</p>
  </section>;
}
