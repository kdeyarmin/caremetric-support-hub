import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdtemp,open,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {validatePublicationMp4Header} from '../src/imports/publicationImportPreview.ts';
import {HttpError} from './sms-auth.mjs';

export async function spoolDocStudioAsset(expected,source,operation) {
  const parent=await realpath(tmpdir()), directory=await mkdtemp(join(parent,'caremetric-docstudio-transfer-')),file=join(directory,'asset');
  const hash=createHash('sha256'); let size=0;
  try {
    await pipeline(Readable.from(source),new Transform({transform(chunk,_encoding,done){
      size+=chunk.length;
      if(size>expected.byteLength) return done(new HttpError(413,'The file exceeds its declared size.'));
      hash.update(chunk); done(null,chunk);
    }}),createWriteStream(file,{flags:'wx',mode:0o600}));
    if(size!==expected.byteLength || hash.digest('hex')!==expected.sha256) throw new HttpError(422,'The file bytes do not match the saved asset.');
    const handle=await open(file,'r'); const header=Buffer.alloc(Math.min(size,65536));
    try { await handle.read(header,0,header.length,0); } finally { await handle.close(); }
    const type=expected.contentType;
    if(type==='video/mp4') { try { validatePublicationMp4Header(header); } catch { throw new HttpError(422,'Invalid video file.'); } }
    if((type==='image/png' && !header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
      || (type==='image/jpeg' && !(header[0]===255 && header[1]===216 && header[2]===255))
      || (type==='audio/wav' && !(header.toString('ascii',0,4)==='RIFF' && header.toString('ascii',8,12)==='WAVE'))
      || (type==='audio/mpeg' && !(header.toString('ascii',0,3)==='ID3' || (header[0]===255 && (header[1]&224)===224)))) throw new HttpError(422,'The file format does not match its type.');
    return await operation(()=>Readable.toWeb(createReadStream(file)));
  } finally {
    const actual=await realpath(directory),child=relative(parent,actual);
    if(actual!==resolve(directory) || isAbsolute(child) || child.startsWith(`..${sep}`) || !child.startsWith('caremetric-docstudio-transfer-')) throw new Error('Unsafe media cleanup path');
    await rm(actual,{recursive:true,force:false});
  }
}
