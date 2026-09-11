import { createHash } from "node:crypto";

const hubOrigin = "https://support-hub-web-production.up.railway.app";
const storageOrigin = "https://xgauehtwksmnoqhgqegm.supabase.co";
const objectPath = /^publications\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(primary|captions|transcript)$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const keys = (value: unknown, expected: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing authorization response");
  const reader=response.body.getReader(); const chunks: Uint8Array[]=[]; let length=0;
  try {
    while (true) {
      const next=await reader.read(); if(next.done) break;
      length+=next.value.length; if(length>8192) throw new Error("Oversized authorization response"); chunks.push(next.value);
    }
    const bytes=new Uint8Array(length); let offset=0;
    for(const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  } finally { await reader.cancel().catch(()=>{}); }
}

async function duplicateUpload(response: Response): Promise<boolean> {
  if(response.status===409) { await response.body?.cancel(); return true; }
  if(response.status!==400) { await response.body?.cancel(); return false; }
  // Storage's documented compatibility response uses HTTP 400 with Duplicate.
  // Never turn an arbitrary authorization, size or request error into a read.
  const value=await boundedJson(response);
  if(!value || typeof value!=="object" || Array.isArray(value)) return false;
  const error=value as Record<string,unknown>;
  return ["ResourceAlreadyExists","KeyAlreadyExists","already_exists"].includes(String(error.code))
    || (error.error==="Duplicate" && error.message==="The resource already exists"
      && [400,409,"400","409"].includes(error.statusCode as string|number));
}

async function verifiedExisting(response: Response, capability: Record<string,unknown>): Promise<number> {
  const declared=response.headers.get("Content-Length");
  const length=declared && /^[1-9][0-9]{0,8}$/.test(declared)?Number(declared):0;
  if(response.status!==200 || !response.body || !length || length>Number(capability.maxBytes)
    || (capability.byteLength!==null && length!==capability.byteLength)
    || response.headers.has("Content-Range") || response.headers.get("Content-Type")?.split(";")[0]!==capability.contentType) {
    await response.body?.cancel(); throw new Error("Stored object metadata mismatch");
  }
  const reader=response.body.getReader(); const hash=createHash("sha256"); let bytes=0;
  try {
    while(true) {
      const next=await reader.read(); if(next.done) break;
      bytes+=next.value.byteLength; if(bytes>length) throw new Error("Stored object exceeds limit");
      hash.update(next.value);
    }
    if(bytes!==length || hash.digest("hex")!==capability.sha256) throw new Error("Stored object content mismatch");
    return bytes;
  } finally { await reader.cancel().catch(()=>{}); }
}

export function createPublicationMediaHandler({serviceKey,fetchImpl=fetch}:{serviceKey:string;fetchImpl?:typeof fetch}) {
  return async (request: Request): Promise<Response> => {
    try {
      if(request.method!=="POST" || request.headers.has("Origin") || request.headers.has("Cookie")) return json({error:"Forbidden"},403);
      const authorization=request.headers.get("Authorization");
      if(!authorization || !/^Bearer cmh_[A-Za-z0-9_-]{43}$/.test(authorization)) return json({error:"Unauthorized"},401);
      const mode=request.headers.get("X-CareMetric-Publication-Mode");
      if(mode!==null && mode!=="cleanup" && mode!=="public") return json({error:"Invalid operation"},400);
      const gate=await fetchImpl(`${hubOrigin}/api/internal/publications/${mode?mode+"/":""}authorize`,{
        method:"POST",headers:{Authorization:authorization,"Content-Type":"application/json"},body:"{}",redirect:"error",signal:AbortSignal.timeout(10000),
      });
      if(!gate.ok) return json({error:"Unauthorized"},gate.status===403?403:401);
      const capability=await boundedJson(gate);
      if(!serviceKey) return json({error:"Storage unavailable"},503);
      const serviceHeaders={apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};
      if(mode==="cleanup") {
        if(!keys(capability,["operation","paths"]) || capability.operation!=="cleanup" || !Array.isArray(capability.paths)
          || capability.paths.length<1 || capability.paths.length>3 || new Set(capability.paths).size!==capability.paths.length
          || capability.paths.some(path=>typeof path!=="string" || !objectPath.test(path))
          || new Set(capability.paths.map(path=>(path as string).split("/")[1])).size!==1) return json({error:"Invalid cleanup capability"},403);
        const removed=await fetchImpl(`${storageOrigin}/storage/v1/object/hub-publications`,{
          method:"DELETE",headers:{...serviceHeaders,"Content-Type":"application/json"},body:JSON.stringify({prefixes:capability.paths}),redirect:"error",signal:AbortSignal.timeout(25000),
        });
        return removed.ok?json({cleaned:true}):json({error:"Cleanup unavailable"},503);
      }
      if(!keys(capability,["path","operation","contentType","sha256","byteLength","maxBytes","range"])
        || typeof capability.path!=="string" || !objectPath.test(capability.path) || !["upload","download"].includes(String(capability.operation))
        || !["text/markdown","video/mp4","text/vtt","text/plain"].includes(String(capability.contentType))
        || typeof capability.sha256!=="string" || !/^[0-9a-f]{64}$/.test(capability.sha256)
        || !Number.isSafeInteger(capability.maxBytes) || Number(capability.maxBytes)<1 || Number(capability.maxBytes)>536870912
        || (capability.byteLength!==null && (!Number.isSafeInteger(capability.byteLength) || Number(capability.byteLength)<1 || Number(capability.byteLength)>Number(capability.maxBytes)))) return json({error:"Invalid capability"},403);
      if(mode==="public" && capability.operation!=="download") return json({error:"Invalid public capability"},403);
      const part=capability.path.split("/")[2];
      if((part==="captions" && capability.contentType!=="text/vtt") || (part==="transcript" && capability.contentType!=="text/plain")
        || (part==="primary" && !["text/markdown","video/mp4"].includes(String(capability.contentType)))
        || (capability.contentType!=="video/mp4" && Number(capability.maxBytes)>(capability.contentType==="text/markdown"?2097152:10485760))) return json({error:"Invalid asset capability"},403);
      const encoded=capability.path.split("/").map(encodeURIComponent).join("/");
      if(capability.operation==="upload") {
        if(capability.range!==null || request.headers.has("Range") || request.headers.get("Content-Type")?.split(";")[0]!==capability.contentType || !request.body) return json({error:"Invalid upload"},415);
        let bytes=0; let verified=false; const hash=createHash("sha256");
        const stream=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
          transform(chunk,controller) {
            bytes+=chunk.length;
            if(bytes>Number(capability.maxBytes) || (capability.byteLength!==null && bytes>Number(capability.byteLength))) throw new Error("Upload exceeds limit");
            hash.update(chunk); controller.enqueue(chunk);
          },
          flush() {
            if(!bytes || (capability.byteLength!==null && bytes!==capability.byteLength) || hash.digest("hex")!==capability.sha256) throw new Error("Upload verification failed");
            verified=true;
          },
        }));
        const deadline=AbortSignal.timeout(110000);
        const result=await fetchImpl(`${storageOrigin}/storage/v1/object/hub-publications/${encoded}`,{
          method:"POST",headers:{...serviceHeaders,"Content-Type":String(capability.contentType),"x-upsert":"false"},body:stream,redirect:"error",signal:deadline,
          // Node integration tests require this flag; Deno accepts it as a fetch extension.
          ...{duplex:"half"},
        });
        if(!result.ok) {
          await stream.cancel().catch(()=>{});
          if(!await duplicateUpload(result)) return json({error:"Immutable upload failed"},503);
          // A prior attempt may have stored exact bytes before its response or
          // SQL verification was lost. Reconcile only this authorized fixed key;
          // never replace or delete the immutable object to repair a retry.
          const existing=await fetchImpl(`${storageOrigin}/storage/v1/object/authenticated/hub-publications/${encoded}`,{
            headers:serviceHeaders,redirect:"error",signal:deadline,
          });
          const storedBytes=await verifiedExisting(existing,capability);
          return json({uploaded:true,sha256:capability.sha256,byteLength:storedBytes});
        }
        await result.body?.cancel();
        if(!verified) return json({error:"Immutable upload failed"},503);
        return json({uploaded:true,sha256:capability.sha256,byteLength:bytes});
      }
      if(!Number.isSafeInteger(capability.byteLength)) return json({error:"Invalid media length"},403);
      let expectedLength=Number(capability.byteLength); let contentRange:string|null=null;
      if(capability.range!==null) {
        if(typeof capability.range!=="string") return json({error:"Invalid range"},403);
        const range=/^bytes=(\d{1,9})-(\d{1,9})$/.exec(capability.range);
        if(!range || Number(range[1])>Number(range[2]) || Number(range[2])>=Number(capability.byteLength)) return json({error:"Invalid range"},403);
        expectedLength=Number(range[2])-Number(range[1])+1;
        contentRange=`bytes ${range[1]}-${range[2]}/${capability.byteLength}`;
      }
      const result=await fetchImpl(`${storageOrigin}/storage/v1/object/authenticated/hub-publications/${encoded}`,{
        headers:{...serviceHeaders,...(capability.range?{Range:String(capability.range)}:{})},redirect:"error",signal:AbortSignal.timeout(110000),
      });
      if(result.status!==(capability.range?206:200) || result.headers.get("Content-Length")!==String(expectedLength)
        || result.headers.get("Content-Type")?.split(";")[0]!==capability.contentType
        || (contentRange && result.headers.get("Content-Range")!==contentRange)) {
        await result.body?.cancel(); return json({error:"Media unavailable"},503);
      }
      return new Response(result.body,{status:result.status,headers:{"Content-Type":String(capability.contentType),"Content-Length":String(expectedLength),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...(contentRange?{"Content-Range":contentRange}:{})}});
    } catch { return json({error:"Publication media unavailable"},503); }
  };
}
