/** Runs outside the Hub. Read-only checks; do not confuse page availability with authenticated activation. */
const targets=[['Support Hub','https://help.caremetric.ai/api/health'],['CareBase','https://cmcarebase.com/health'],['CareMetric Intel','https://www.caremetricintel.com/api/ready']];
let failed=false;
for(const [name,url] of targets) {
 try {const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});await response.body?.cancel();if(!response.ok)throw new Error(`HTTP ${response.status}`);console.log(`${name}: available`);}
 catch {failed=true;console.error(`${name}: unavailable or timed out`);}
}
if(failed)process.exitCode=1;
