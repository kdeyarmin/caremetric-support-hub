// Actual private DocStudio bucket recovery, only in the disposable CI stack.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.HUB_RUN_STORAGE_RECOVERY_DRILL,'disposable-object-loss');
assert.equal(process.env.HUB_TEST_DATABASE_URL,'postgresql://postgres:postgres@127.0.0.1:54322/postgres');
const {stdout}=await promisify(execFile)('npx',['supabase','status','--output','json'],{timeout:30000,maxBuffer:1000000});
let config=JSON.parse(stdout);assert.equal(config.API_URL,'http://127.0.0.1:54321');assert.equal(config.DB_URL,process.env.HUB_TEST_DATABASE_URL);
const fixedFetch=(input,options={})=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);assert.equal(url.origin,'http://127.0.0.1:54321');return fetch(input,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});};
const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:fixedFetch}};
const storage=createClient(config.API_URL,config.SERVICE_ROLE_KEY,options).storage,anonymous=createClient(config.API_URL,config.ANON_KEY,options).storage;config=null;
const bucket='hub-docstudio',project=randomUUID(),asset=randomUUID(),job=randomUUID();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLioAAAAASUVORK5CYII=','base64');
const fixtures=[{path:`assets/${project}/${asset}`,type:'image/png',bytes:png},{path:`renders/${job}/1/captions`,type:'text/vtt',bytes:Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nSynthetic recovery.\n')},{path:`renders/${job}/1/transcript`,type:'text/plain',bytes:Buffer.from('Synthetic recovery.\n')}];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const take=(result)=>{assert.equal(result.error,null);return result.data;};
const paths=fixtures.map(file=>file.path);
async function verify(file){const blob=take(await storage.from(bucket).download(file.path));assert.equal(blob.type.split(';')[0],file.type);const bytes=Buffer.from(await blob.arrayBuffer());assert.equal(bytes.length,file.bytes.length);assert.equal(hash(bytes),hash(file.bytes));assert.ok((await anonymous.from(bucket).download(file.path)).error);return bytes;}
async function restore(archive){
 // Validate all names, sizes and digests before the first upload.
 assert.equal(archive.length,fixtures.length);
 for(const [index,file] of archive.entries()){assert.equal(file.path,fixtures[index].path);assert.equal(file.type,fixtures[index].type);assert.equal(file.bytes.length,fixtures[index].bytes.length);assert.equal(hash(file.bytes),file.sha256);}
 for(const file of archive)take(await storage.from(bucket).upload(file.path,file.bytes,{contentType:file.type,upsert:false}));
}
try {
 const info=take(await storage.getBucket(bucket));assert.equal(info.public,false);
 for(const file of fixtures)take(await storage.from(bucket).upload(file.path,file.bytes,{contentType:file.type,upsert:false}));
 const archive=[];for(const file of fixtures)archive.push({...file,bytes:await verify(file),sha256:hash(file.bytes)});
 take(await storage.from(bucket).remove(paths));
 await assert.rejects(restore(archive.map((file,index)=>index?file:{...file,sha256:'0'.repeat(64)})));
 for(const file of fixtures)assert.ok((await storage.from(bucket).download(file.path)).error);
 await restore(archive);for(const file of fixtures)await verify(file);
 assert.equal(take(await storage.getBucket(bucket)).public,false);
 console.log('Actual hub-docstudio Storage recovery passed: immutable source image, captions and transcript bytes, digest rejection and anonymous denial.');
} finally {take(await storage.from(bucket).remove(paths));}
