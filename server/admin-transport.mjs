import { HttpError } from './sms-auth.mjs';

/** Fixed registry destinations only; callers never supply a URL or header name. */
export async function callNativeAdmin(fetcher, target, authorizationHeader, capability, operation, project, command = false) {
  const signal = AbortSignal.timeout(12000);
  try {
    const response = await fetcher(target, {
      method:'POST', headers:{[authorizationHeader]:`Bearer ${capability}`,'Content-Type':'application/json'},
      body:JSON.stringify(operation), signal, redirect:'error', cache:'no-store',
    });
    if (!response.ok) {
      // The native error body is never forwarded or logged.
      if (response.status===401 || response.status===403) throw new HttpError(response.status,'Administrator access could not be verified.');
      if (response.status===404) throw new HttpError(404,'Record unavailable.','notfound');
      if (command && response.status===409) throw new HttpError(409,'The preview changed or expired. Reload before creating another preview.','conflict');
      throw new HttpError(503,'Administrator connection is unavailable.','upstream');
    }
    if (!response.body) throw new Error('Missing response');
    const reader=response.body.getReader();
    const chunks=[]; let size=0;
    const cancel=()=>{ void reader.cancel().catch(()=>{}); };
    signal.addEventListener('abort',cancel,{once:true});
    try {
      for (;;) {
        signal.throwIfAborted();
        const {done,value}=await reader.read();
        if (done) break;
        size+=value.byteLength;
        if (size>1000000) { await reader.cancel(); throw new Error('Oversized response'); }
        chunks.push(Buffer.from(value));
      }
      signal.throwIfAborted();
    } finally { signal.removeEventListener('abort',cancel); reader.releaseLock(); }
    return project(JSON.parse(Buffer.concat(chunks,size).toString('utf8')));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503,'Administrator connection is unavailable.','upstream');
  }
}
