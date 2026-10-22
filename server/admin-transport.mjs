import { HttpError } from './sms-auth.mjs';

const learningValidation=['https://cmcarebase.com/api/learning-admin/authoring','https://cmcarebase.com/api/learning-admin/catalog'];
/** Fixed registry destinations only; callers never supply a URL or header name. */
export async function callNativeAdmin(fetcher, target, authorizationHeader, capability, operation, project, command = false, parentSignal, maximumBytes = 1000000) {
  const trainingReport = target === 'https://cmcarebase.com/api/platform-admin/training'
    && operation.domain === 'training.v1' && operation.operation === 'enrollments.report';
  const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(12000)]);
  try {
    const response = await fetcher(target, {
      method:'POST', headers:{[authorizationHeader]:`Bearer ${capability}`,'Content-Type':'application/json'},
      body:JSON.stringify(operation), signal, redirect:'error', cache:'no-store',
    });
    if (!response.ok) {
      // The native error body is never forwarded or logged.
      if (response.status===401 || response.status===403) throw new HttpError(response.status,'Administrator access could not be verified.');
      if (response.status===404) throw new HttpError(404,'Record unavailable.','notfound');
      if (trainingReport && response.status===413) throw new HttpError(413,'Narrow the report filters before exporting.','report_too_large');
      if (target==='https://cmcarebase.com/api/platform-admin/training' && response.status===400) throw new HttpError(400,'Review the training request and try again.','invalid_request');
      if (command && response.status===409) throw new HttpError(409,'The preview changed or expired. Reload before creating another preview.','conflict');
      // Learning commands validate records CareBase can see and the Hub cannot, such as an unavailable course.
      if (learningValidation.includes(target) && response.status===400) throw new HttpError(400,'Review the request and try again.','invalid_request');
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
        if (size>maximumBytes) {
          await reader.cancel().catch(()=>{});
          if (trainingReport) throw new HttpError(413,'Narrow the report filters before exporting.','report_too_large');
          throw new Error('Oversized response');
        }
        chunks.push(Buffer.from(value));
      }
      signal.throwIfAborted();
    } finally { signal.removeEventListener('abort',cancel); reader.releaseLock(); }
    return await project(JSON.parse(Buffer.concat(chunks,size).toString('utf8')));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503,'Administrator connection is unavailable.','upstream');
  }
}
