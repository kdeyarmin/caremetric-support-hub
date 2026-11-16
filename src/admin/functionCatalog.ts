import type {PortfolioCapabilities,PortfolioOperationName,PortfolioProduct} from '../../supabase/functions/_shared/portfolioProtocol';

export type AdminView='overview'|'organizations'|'users'|'inquiries'|'training'|'courses'|'jobs'|'releases'|'audit';
export interface AdminFunction {
  id:string; title:string; description:string; view:AdminView;
  requires:readonly PortfolioOperationName[]; carebaseOnly?:boolean; advisorsOnly?:boolean;
  /** Only these applications offer the function, even if another advertised the same operation names. */
  products?:readonly PortfolioProduct[];
}
// Requirements mirror the actual workspace controls, including their parent view.
// A connected read never implies permission to change its records.
export const adminFunctions:readonly AdminFunction[]=[
  {id:'overview',title:'Application overview',description:'Read current organization and account totals.',view:'overview',requires:['overview']},
  {id:'organizations',title:'Organization directory',description:'Find organizations and inspect their recorded status.',view:'organizations',requires:['organizations.list']},
  {id:'users',title:'User directory',description:'Find application accounts and inspect their current roles and status.',view:'users',requires:['users.list']},
  {id:'inquiries',title:'Consultation requests',description:'Read Healthcare Advisors consultation requests, set their status and notes, or delete them.',view:'inquiries',requires:['inquiries.list'],advisorsOnly:true},
  {id:'org-access',title:'Organization access',description:'Select an organization, review suspension or restoration, then confirm the exact change.',view:'organizations',requires:['organizations.list','commands.preview','commands.apply'],carebaseOnly:true},
  {id:'user-access',title:'User access',description:'Select an eligible user or account and review turning it on or off. Administrator accounts remain protected.',view:'users',requires:['users.list','commands.preview','commands.apply'],products:['carebase','intel']},
  {id:'org-lifecycle',title:'Organization suspend and restore',description:'Review suspending or restoring a Breathe organization; Breathe keeps every review and its receipt.',view:'organizations',requires:['organizations.list','organizations.lifecycle.context','organizations.lifecycle.preview','organizations.lifecycle.apply','organizations.lifecycle.resume'],products:['breathe']},
  {id:'staff-access',title:'Staff sign-in access',description:'Review turning a Breathe staff sign-in off, as Revoke does in Breathe, or back on when the Hub turned it off; Breathe keeps every review and its receipt.',view:'users',requires:['users.list','staff.access.context','staff.access.preview','staff.access.apply','staff.access.resume'],products:['breathe']},
  {id:'courses',title:'Native course catalog',description:'Inspect course versions, lessons and publication status before opening shared authoring.',view:'courses',requires:['courses.list','courses.get'],carebaseOnly:true},
  {id:'training',title:'Facility training administration',description:'Set up a training facility and manage its students, enrollments, certificates and reports from the Hub.',view:'training',requires:['training.v1','organizations.list'],carebaseOnly:true},
  {id:'training-access',title:'Training module access',description:'Review complimentary or contracted module terms for a selected training organization.',view:'training',requires:['training.v1','organizations.list'],carebaseOnly:true},
  {id:'jobs',title:'System jobs',description:'Inspect job definitions, recent outcomes and failures.',view:'jobs',requires:['operations.jobs.list'],carebaseOnly:true},
  {id:'job-stop',title:'Job stop controls',description:'Review a job’s stop switch and whether it can stop that execution type.',view:'jobs',requires:['operations.jobs.list','operations.config.v1'],carebaseOnly:true},
  {id:'releases',title:'Release settings',description:'Inspect release rollout, organization overrides and retained cohorts.',view:'releases',requires:['operations.releases.list'],carebaseOnly:true},
  {id:'release-change',title:'Release and feature stop controls',description:'Review global rollout or a feature stop for all organizations or one exact organization.',view:'releases',requires:['operations.releases.list','operations.config.v1'],carebaseOnly:true},
  {id:'audit',title:'Administrative audit records',description:'Read retained native administrative activity.',view:'audit',requires:['operations.audit.list'],carebaseOnly:true},
];
export function functionAvailable(item:AdminFunction,product:PortfolioProduct,capabilities:PortfolioCapabilities|null){
  return Boolean(capabilities&&(!item.carebaseOnly||product==='carebase')&&(!item.advisorsOnly||product==='advisors')&&(!item.products||item.products.includes(product))&&item.requires.every(operation=>capabilities.operations.includes(operation)));
}
export function searchFunctions(query:string){
  const terms=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return adminFunctions.filter(item=>terms.every(term=>`${item.title} ${item.description}`.toLowerCase().includes(term)));
}
