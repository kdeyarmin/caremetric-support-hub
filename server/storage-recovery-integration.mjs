// Real Storage byte recovery in disposable CI. Never accepts a remote project.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { createClient } from '@supabase/supabase-js';

assert.equal(process.env.GITHUB_ACTIONS,'true','Storage recovery requires disposable GitHub CI');
assert.equal(process.env.HUB_RUN_STORAGE_RECOVERY_DRILL,'disposable-object-loss','Explicit object-loss opt-in required');
assert.ok(process.env.HUB_TEST_DATABASE_URL==='postgresql://postgres:postgres@127.0.0.1:54322/postgres','Only the fixed disposable database is allowed');
let config;
try {
  const {stdout}=await promisify(execFile)('npx',['supabase','status','--output','json'],{timeout:30000,maxBuffer:1000000});
  config=JSON.parse(stdout);
} catch { throw new Error('Could not inspect the disposable Supabase runtime'); }
assert.ok(config.API_URL==='http://127.0.0.1:54321' && config.DB_URL===process.env.HUB_TEST_DATABASE_URL,'CLI must identify the exact disposable project');
assert.ok(typeof config.SERVICE_ROLE_KEY==='string' && typeof config.ANON_KEY==='string','Disposable Storage credentials required');
const fixedFetch=(input,options={})=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  assert.ok(url.origin==='http://127.0.0.1:54321','Storage requests must stay local');
  return fetch(input,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});
};
const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:fixedFetch}};
const storage=createClient(config.API_URL,config.SERVICE_ROLE_KEY,options).storage;
const anonymous=createClient(config.API_URL,config.ANON_KEY,options).storage;
config=null;
const bucket='hub-recovery-'+randomUUID();
assert.match(bucket,/^hub-recovery-[0-9a-f-]{36}$/);
const archive=await mkdtemp(join(tmpdir(),'hub-storage-recovery-'));
const fixtures=[
  {path:'content/course.md',contentType:'text/markdown',bytes:Buffer.from('# Synthetic course\n\nExact source evidence.\n')},
  {path:'content/captions.vtt',contentType:'text/vtt',bytes:Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nSynthetic caption.\n')},
  {path:'content/object.bin',contentType:'application/octet-stream',bytes:randomBytes(8192)},
];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths=fixtures.map(file=>file.path);
const requireData=(result,label)=>{
  if(result.error)throw new Error(`${label} failed (${String(result.error.statusCode??'storage')})`);
  return result.data;
};
const checkBytes=async(file)=>{
  const blob=requireData(await storage.from(bucket).download(file.path,{}, {cache:'no-store'}),'Private download');
  const bytes=Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.length,file.size);assert.equal(sha(bytes),file.sha256);
  assert.equal(blob.type.split(';')[0],file.contentType);
  const denied=await anonymous.from(bucket).download(file.path,{}, {cache:'no-store'});
  assert.ok(denied.error && denied.data===null,'Restored private bytes must remain unavailable anonymously');
  return bytes;
};
async function restore(manifest) {
  assert.equal(manifest.contract,'hub.storage-recovery.v1');
  assert.equal(manifest.bucket,bucket);assert.equal(manifest.files.length,fixtures.length);
  // Validate the WHOLE archive before the first restore write.
  const checked=[];
  for(const [index,file] of manifest.files.entries()) {
    assert.equal(file.path,fixtures[index].path);assert.equal(file.contentType,fixtures[index].contentType);
    assert.equal(file.archiveName,`${index}.bin`);assert.match(file.sha256,/^[0-9a-f]{64}$/);
    const bytes=await readFile(join(archive,file.archiveName));
    assert.equal(bytes.length,file.size);assert.equal(sha(bytes),file.sha256);
    checked.push({file,bytes});
  }
  for(const {file,bytes} of checked) requireData(await storage.from(bucket).upload(file.path,bytes,{contentType:file.contentType,upsert:false}),'Restore upload');
}
let created=false;
try {
  requireData(await storage.createBucket(bucket,{public:false,fileSizeLimit:1048576,allowedMimeTypes:fixtures.map(file=>file.contentType)}),'Create isolated bucket');
  created=true;
  const manifest={contract:'hub.storage-recovery.v1',bucket,files:[]};
  for(const [index,file] of fixtures.entries()) {
    requireData(await storage.from(bucket).upload(file.path,file.bytes,{contentType:file.contentType,upsert:false}),'Seed synthetic object');
    const entry={path:file.path,contentType:file.contentType,size:file.bytes.length,sha256:sha(file.bytes),archiveName:`${index}.bin`};
    const downloaded=await checkBytes(entry);
    await writeFile(join(archive,entry.archiveName),downloaded);manifest.files.push(entry);
  }
  await writeFile(join(archive,'manifest.json'),JSON.stringify(manifest));
  const started=Date.now();
  requireData(await storage.from(bucket).remove(paths),'Lose exact synthetic objects');
  for(const file of fixtures) assert.ok((await storage.from(bucket).download(file.path,{}, {cache:'no-store'})).error,'Deleted bytes must be unavailable');
  const damaged=structuredClone(manifest);damaged.files[1].sha256='0'.repeat(64);
  await assert.rejects(restore(damaged),/strictly equal/);
  assert.deepEqual(requireData(await storage.from(bucket).list('content'),'List empty bucket'),[],'Invalid archive must not partially restore');
  const unsafe=structuredClone(manifest);unsafe.files[0].archiveName='../unexpected';
  await assert.rejects(restore(unsafe),/strictly equal/);
  await restore(JSON.parse(await readFile(join(archive,'manifest.json'),'utf8')));
  for(const file of manifest.files) await checkBytes(file);
  const restoredBucket=requireData(await storage.getBucket(bucket),'Inspect restored bucket');
  assert.equal(restoredBucket.public,false);
  console.log(JSON.stringify({drill:'hub-storage-byte-recovery',objects:manifest.files.length,bytes:manifest.files.reduce((sum,file)=>sum+file.size,0),
    elapsedMs:Date.now()-started,checks:['exact SHA-256','exact sizes','content types','private access','corrupt archive rejected before writes','closed archive paths'],
    excluded:['production retention','separate project disaster recovery','off-site backup replication','media playback validation']}));
} finally {
  if(created){await storage.from(bucket).remove(paths);await storage.deleteBucket(bucket);}
  const resolved=resolve(archive),temporaryRoot=resolve(tmpdir())+sep;
  assert.ok(resolved.startsWith(temporaryRoot) && /^hub-storage-recovery-[A-Za-z0-9_-]+$/.test(basename(resolved)),'Only this temporary archive may be removed');
  await rm(resolved,{recursive:true,force:true});
}
