// Storage transport only. SMS codes and sign-in are handled by the Hub app.
const appOrigin = "https://support-hub-web-production.up.railway.app";
const storageOrigin = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const json = (body:unknown,status=200) => Response.json(body,{ status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"} });
Deno.serve(async request => {
  try {
    if(request.method!=="POST" || request.headers.has("Origin")) return json({error:"Forbidden"},403);
    const authorization=request.headers.get("Authorization");
    if(!authorization || !/^Bearer cmh_[A-Za-z0-9_-]{43}$/.test(authorization)) return json({error:"Unauthorized"},401);
    const gate=await fetch(`${appOrigin}/api/internal/media/authorize`,{
      method:"POST",headers:{Authorization:authorization,"Content-Type":"application/json"},body:"{}",redirect:"manual",signal:AbortSignal.timeout(10000),
    });
    if(!gate.ok) return json({error:"Unauthorized"},401);
    const {path,operation}=await gate.json();
    if(typeof path!=="string" || !/^learning\/[0-9a-f-]{36}\/(video.mp4|captions.vtt|transcript.txt)$/.test(path)
      || !["upload","download","sign"].includes(operation)) return json({error:"Invalid capability"},403);
    const encoded=path.split("/").map(encodeURIComponent).join("/");
    const headers:Record<string,string>={apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};
    if(operation==="sign") {
      const result=await fetch(`${storageOrigin}/storage/v1/object/sign/hub-learning/${encoded}`,{
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
      const response=await fetch(`${storageOrigin}/storage/v1/object/hub-learning/${encoded}`,{
        method:"POST",headers:{...headers,"Content-Type":expected[0],"x-upsert":"false"},body:bounded,redirect:"manual",signal:AbortSignal.timeout(110000),
      });
      return response.ok?json({uploaded:true}):json({error:"Upload failed"},response.status===409?409:503);
    }
    const response=await fetch(`${storageOrigin}/storage/v1/object/authenticated/hub-learning/${encoded}`,{headers,redirect:"manual",signal:AbortSignal.timeout(110000)});
    if(!response.ok) return json({error:"Media unavailable"},response.status===404?404:503);
    return new Response(response.body,{headers:{"Content-Type":expected[0],"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  } catch { return json({error:"Media transfer unavailable"},503); }
});
