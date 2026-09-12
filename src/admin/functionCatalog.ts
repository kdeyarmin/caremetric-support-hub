import type {PortfolioCapabilities,PortfolioOperationName,PortfolioProduct} from '../../supabase/functions/_shared/portfolioProtocol';

export type AdminView='overview'|'organizations'|'users'|'billing'|'courses'|'jobs'|'releases'|'audit';
export interface AdminFunction {
  id:string; title:string; description:string; view:AdminView;
  requires:readonly PortfolioOperationName[]; carebaseOnly?:boolean;
}
// Requirements mirror the actual workspace controls, including their parent view.
// A connected read never implies permission to change its records.
export const adminFunctions:readonly AdminFunction[]=[
  {id:'overview',title:'Application overview',description:'Read current organization, account and subscription totals.',view:'overview',requires:['overview']},
  {id:'organizations',title:'Organization directory',description:'Find organizations and inspect their recorded status.',view:'organizations',requires:['organizations.list']},
  {id:'users',title:'User directory',description:'Find application accounts and inspect their current roles and status.',view:'users',requires:['users.list']},
  {id:'org-access',title:'Organization access',description:'Select an organization, review suspension or restoration, then confirm the exact change.',view:'organizations',requires:['organizations.list','commands.preview','commands.apply'],carebaseOnly:true},
  {id:'user-access',title:'User access',description:'Select an eligible user and review activation or deactivation. Administrator accounts remain protected.',view:'users',requires:['users.list','commands.preview','commands.apply'],carebaseOnly:true},
  {id:'billing',title:'Subscriptions and billing status',description:'Inspect subscriptions recorded by the application. Provider comparisons are separate controls.',view:'billing',requires:['billing.overview','billing.subscriptions.list']},
  {id:'billing-verify',title:'Verify subscription with Stripe',description:'Compare a selected subscription with its current provider record when billing is configured.',view:'billing',requires:['billing.overview','billing.subscriptions.list','billing.subscriptions.verify'],carebaseOnly:true},
  {id:'invoices',title:'Invoice records',description:'Inspect invoice details in the billing workspace.',view:'billing',requires:['billing.overview','billing.subscriptions.list','billing.invoices.list'],carebaseOnly:true},
  {id:'billing-access',title:'Billing access override',description:'Review a selected organization’s access override and its recorded reason.',view:'billing',requires:['billing.overview','billing.subscriptions.list','commands.preview','commands.apply'],carebaseOnly:true},
  {id:'portal',title:'Billing portal',description:'Choose an organization and review a provider billing portal request.',view:'organizations',requires:['organizations.list','billing.commands.preview','billing.commands.apply'],carebaseOnly:true},
  {id:'checkout',title:'Subscription checkout',description:'Choose an organization, compare configured packages, and review checkout before creating it.',view:'organizations',requires:['organizations.list','billing.packages.list','billing.checkout.preview','billing.checkout.apply','billing.checkout.check','billing.checkout.recover'],carebaseOnly:true},
  {id:'courses',title:'Native course catalog',description:'Inspect course versions, lessons and publication status before opening shared authoring.',view:'courses',requires:['courses.list','courses.get'],carebaseOnly:true},
  {id:'jobs',title:'System jobs',description:'Inspect job definitions, recent outcomes and failures.',view:'jobs',requires:['operations.jobs.list'],carebaseOnly:true},
  {id:'job-stop',title:'Job stop controls',description:'Review a job’s stop switch and whether it can stop that execution type.',view:'jobs',requires:['operations.jobs.list','operations.config.v1'],carebaseOnly:true},
  {id:'releases',title:'Release settings',description:'Inspect release rollout, organization overrides and retained cohorts.',view:'releases',requires:['operations.releases.list'],carebaseOnly:true},
  {id:'release-change',title:'Release and feature stop controls',description:'Review global rollout or a feature stop for all organizations or one exact organization.',view:'releases',requires:['operations.releases.list','operations.config.v1'],carebaseOnly:true},
  {id:'audit',title:'Administrative audit records',description:'Read retained native administrative activity.',view:'audit',requires:['operations.audit.list'],carebaseOnly:true},
];
export function functionAvailable(item:AdminFunction,product:PortfolioProduct,capabilities:PortfolioCapabilities|null){
  return Boolean(capabilities&&(!item.carebaseOnly||product==='carebase')&&item.requires.every(operation=>capabilities.operations.includes(operation)));
}
export function searchFunctions(query:string){
  const terms=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return adminFunctions.filter(item=>terms.every(term=>`${item.title} ${item.description}`.toLowerCase().includes(term)));
}
