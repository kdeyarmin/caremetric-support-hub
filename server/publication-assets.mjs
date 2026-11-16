import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { publicationPartRules } from '../src/imports/publicationProtocol.ts';
import { validatePublicationMp4Header, validatePublicationText } from '../src/imports/publicationImportPreview.ts';
import { HttpError } from './sms-auth.mjs';

/** No client filename or path reaches the filesystem. Large media is streamed. */
export async function spoolPublicationAsset(manifest, part, source, operation) {
  const rules=publicationPartRules(manifest,part);
  const directory=await mkdtemp(join(tmpdir(),'caremetric-publication-'));
  const file=join(directory,'asset');
  let byteLength=0;
  const hash=createHash('sha256');
  try {
    const bounded=new Transform({transform(chunk,_encoding,done) {
      byteLength+=chunk.length;
      if(byteLength>rules.maxBytes || (rules.byteLength!==null && byteLength>rules.byteLength)) return done(new HttpError(413,'Publication file exceeds its declared limit.'));
      hash.update(chunk); done(null,chunk);
    }});
    await pipeline(Readable.from(source),bounded,createWriteStream(file,{flags:'wx',mode:0o600}));
    return await checkedPublicationAsset(manifest,part,{file,sha256:hash.digest('hex'),byteLength},operation);
  } finally {
    // The path is a private, freshly generated child of the runtime temp dir.
    await rm(directory,{recursive:true,force:true});
  }
}

/**
 * A whole asset already on disk (spooled above, or sent in parts by server/upload-parts.mjs): its size and hash must match the
 * manifest and its content must pass the format checks before `operation` may store it.
 */
export async function checkedPublicationAsset(manifest, part, {file, sha256, byteLength}, operation) {
  const rules=publicationPartRules(manifest,part);
  if(byteLength>rules.maxBytes) throw new HttpError(413,'Publication file exceeds its declared limit.');
  if(!byteLength || (rules.byteLength!==null && byteLength!==rules.byteLength) || sha256!==rules.sha256) throw new HttpError(422,'Publication asset hash or byte length does not match.');
  let bodyText=null;
  try {
    if(part==='primary' && manifest.content.kind==='video') {
      // ftyp is a small format header; reject giant boxes rather than buffering
      // a potentially 512MiB movie. The full movie hash has already been checked.
      const handle=await open(file,'r');
      try {
        const prefix=Buffer.alloc(Math.min(65536,byteLength));
        await handle.read(prefix,0,prefix.length,0);
        validatePublicationMp4Header(prefix);
      } finally { await handle.close(); }
    } else {
      const textBytes=await readFile(file);
      validatePublicationText(textBytes,part==='primary'?'article':part,manifest.artifact.duration_ms);
      // Preserve a UTF-8 BOM in the stored article text so SQL can verify the
      // exact original bytes, while the shared text validator handles it.
      if(part==='primary') bodyText=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(textBytes);
    }
  } catch { throw new HttpError(422,'Publication asset content checks failed.'); }
  return await operation({sha256,byteLength,bodyText,contentType:rules.contentType,stream:()=>Readable.toWeb(createReadStream(file))});
}

/** One byte range only. All calculations stay within the 512MiB asset bound. */
export function publicationRange(header,length) {
  if(header===undefined || header===null) return null;
  if(typeof header!=='string' || header.length>80 || !Number.isSafeInteger(length) || length<1 || length>536870912) throw new HttpError(416,'Unsupported media range.');
  const match=/^bytes=(\d{1,9})?-(\d{1,9})?$/.exec(header);
  if(!match || (!match[1] && !match[2])) throw new HttpError(416,'Unsupported media range.');
  let start,end;
  if(!match[1]) {
    const suffix=Number(match[2]); if(suffix<1) throw new HttpError(416,'Unsupported media range.');
    start=Math.max(0,length-suffix); end=length-1;
  } else {
    start=Number(match[1]); end=match[2]?Math.min(Number(match[2]),length-1):length-1;
    if(start>=length || end<start) throw new HttpError(416,'Unsupported media range.');
  }
  return {start,end,header:`bytes=${start}-${end}`,length:end-start+1};
}
