import {useState} from 'react';
import {JobRecords,ReleaseRecords} from './OperationalRecords';
import {ConfigurationPanel} from './ConfigurationPanel';
import type {ConfigurationTarget} from './configurationProtocol';
export function OperationalWorkspace({view,canConfigure}:{view:'jobs'|'releases';canConfigure:boolean}){
  const [selection,setSelection]=useState<{target:ConfigurationTarget;label:string}|null>(null),[revision,setRevision]=useState(0),[organization,setOrganization]=useState('');
  const validOrganization=organization.trim()===''||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organization.trim());
  const configure=canConfigure?(target:ConfigurationTarget,label:string)=>setSelection({target,label}):undefined;
  return <>{canConfigure&&view==='releases'&&<label>Organization ID for feature stop (leave empty for global)<input value={organization} disabled={selection!==null} onChange={event=>setOrganization(event.target.value)}/>{!validOrganization&&<span role="alert">Enter the exact organization UUID from the organization directory.</span>}</label>}
    {selection&&<ConfigurationPanel key={JSON.stringify(selection.target)} {...selection} onApplied={()=>setRevision(value=>value+1)} onClose={()=>setSelection(null)}/>}
    {view==='jobs'?<JobRecords key={revision} onConfigure={configure} controlsDisabled={selection!==null}/>
      :<ReleaseRecords key={revision} onConfigure={configure} controlsDisabled={selection!==null||!validOrganization} organizationId={organization.trim()||null}/>}</>;
}
