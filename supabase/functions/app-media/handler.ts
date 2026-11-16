// Storage transport only. SMS codes and sign-in are handled by the Hub app.
const appOrigin = "https://support-hub-web-production.up.railway.app";
const lessonPath = /^learning\/[0-9a-f-]{36}\/(video.mp4|captions.vtt|transcript.txt)$/;
const json = (body:unknown,status=200) => Response.json(body,{ status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"} });

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing response");
  const reader=response.body.getReader(); const chunks: Uint8Array[]=[]; let length=0;
  try {
    while (true) {
      const next=await reader.read(); if(next.done) break;
      length+=next.value.length; if(length>8192) throw new Error("Oversized response"); chunks.push(next.value);
    }
    const bytes=new Uint8Array(length); let offset=0;
    for(const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  } finally { await reader.cancel().catch(()=>{}); }
}

// Storage answers an existing key with 409, or with its older 400 "Duplicate" body. Any other refusal is not read as one.
async function duplicate(response: Response): Promise<boolean> {
  if(response.status===409) { await response.body?.cancel(); return true; }
  if(response.status!==400) { await response.body?.cancel(); return false; }
  const value=await boundedJson(response);
  if(!value || typeof value!=="object" || Array.isArray(value)) return false;
  const error=value as Record<string,unknown>;
  return (typeof error.code==="string" && ["ResourceAlreadyExists","KeyAlreadyExists","already_exists"].includes(error.code))
    || (error.code===undefined && error.error==="Duplicate" && [400,409,"400","409"].includes(error.statusCode as string|number));
}

export function createAppMediaHandler({storageOrigin,serviceKey,fetchImpl=fetch}:{storageOrigin:string;serviceKey:string;fetchImpl?:typeof fetch}) {
  return async (request: Request): Promise<Response> => {
    try {
      if(request.method!=="POST" || request.headers.has("Origin")) return json({error:"Forbidden"},403);
      const authorization=request.headers.get("Authorization");
      if(!authorization || !/^Bearer cmh_[A-Za-z0-9_-]{43}$/.test(authorization)) return json({error:"Unauthorized"},401);
      const gate=await fetchImpl(`${appOrigin}/api/internal/media/authorize`,{
        method:"POST",headers:{Authorization:authorization,"Content-Type":"application/json"},body:"{}",redirect:"manual",signal:AbortSignal.timeout(10000),
      });
      if(!gate.ok) return json({error:"Unauthorized"},401);
      const capability=await boundedJson(gate);
      const {path,operation}=(capability && typeof capability==="object" ? capability : {}) as Record<string,unknown>;
      if(typeof path!=="string" || !lessonPath.test(path)
        || typeof operation!=="string" || !["upload","download","sign","upload-sign"].includes(operation)) return json({error:"Invalid capability"},403);
      const encoded=path.split("/").map(encodeURIComponent).join("/");
      const headers:Record<string,string>={apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};
      if(operation==="upload-sign") {
        // The Hub's direct transfer (docs/CENTRAL_LEARNING.md): a one-time upload address for this exact object that cannot overwrite
        // it (no x-upsert), so a large video does not pass through this function's time limits. {stored: true} when Storage
        // already holds the object: the Hub then reads it back and compares it. Only the token is returned; the Hub builds the
        // address from its own Storage origin and the object it asked for.
        const signed=await fetchImpl(`${storageOrigin}/storage/v1/object/upload/sign/hub-learning/${encoded}`,{
          method:"POST",headers:{...headers,"Content-Type":"application/json"},body:"{}",redirect:"manual",signal:AbortSignal.timeout(10000),
        });
        if(!signed.ok) return await duplicate(signed) ? json({stored:true}) : json({error:"Media unavailable"},503);
        const data=await boundedJson(signed);
        const address=data && typeof data==="object" && !Array.isArray(data) ? (data as Record<string,unknown>).url : undefined;
        const prefix=`/object/upload/sign/hub-learning/${encoded}?token=`;
        if(typeof address!=="string" || !address.startsWith(prefix) || !/^[A-Za-z0-9._~-]{16,4096}$/.test(address.slice(prefix.length))) return json({error:"Invalid media response"},503);
        return json({token:address.slice(prefix.length)});
      }
      if(operation==="sign") {
        const result=await fetchImpl(`${storageOrigin}/storage/v1/object/sign/hub-learning/${encoded}`,{
          method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({expiresIn:600}),redirect:"manual",signal:AbortSignal.timeout(10000),
        });
        if(!result.ok) return json({error:"Media unavailable"},result.status===404?404:503);
        const data=await result.json();
        if(typeof data.signedURL!=="string" || !data.signedURL.startsWith("/object/sign/hub-learning/")) return json({error:"Invalid media response"},503);
        return json({signedUrl:`${storageOrigin}/storage/v1${data.signedURL}`});
      }
      const expected=path.endsWith("/video.mp4")?["video/mp4",268435456] as const:path.endsWith("/captions.vtt")?["text/vtt",2000000] as const:["text/plain",1000000] as const;
      if(operation==="upload") {
        if(request.headers.get("Content-Type")?.split(";")[0]!==expected[0] || !request.body) return json({error:"Invalid media"},415);
        let bytes=0;
        const bounded=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
          bytes+=chunk.length; if(bytes>expected[1]) throw new Error("Media too large"); controller.enqueue(chunk);
        }}));
        const response=await fetchImpl(`${storageOrigin}/storage/v1/object/hub-learning/${encoded}`,{
          method:"POST",headers:{...headers,"Content-Type":expected[0],"x-upsert":"false"},body:bounded,redirect:"manual",signal:AbortSignal.timeout(110000),
          // Node tests require this flag; Deno accepts it as a fetch extension.
          ...{duplex:"half"},
        });
        return response.ok?json({uploaded:true}):json({error:"Upload failed"},response.status===409?409:503);
      }
      const response=await fetchImpl(`${storageOrigin}/storage/v1/object/authenticated/hub-learning/${encoded}`,{headers,redirect:"manual",signal:AbortSignal.timeout(110000)});
      if(!response.ok) return json({error:"Media unavailable"},response.status===404?404:503);
      return new Response(response.body,{headers:{"Content-Type":expected[0],"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
    } catch { return json({error:"Media transfer unavailable"},503); }
  };
}
