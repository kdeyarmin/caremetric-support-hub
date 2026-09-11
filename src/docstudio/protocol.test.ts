import {describe,it,expect} from 'vitest';
import {commandSchema,draftSchema,type Draft} from './protocol';
const article:Draft={kind:'article',title:'Shared guide',summary:'A reusable guide.',locale:'en-US',accessLevel:'customer',products:['carebase'],markdown:'# Guide\n',assets:[],scenes:[]};
const image={id:'12345678-1234-4234-8234-123456789012',sha256:'a'.repeat(64),byteLength:500,mediaType:'image/png' as const};
describe('DocStudio saved content boundary',()=>{
 it('rejects external URLs, raw commands, invented approval and duplicated product scope',()=>{
  expect(draftSchema.safeParse({...article,url:'https://untrusted.test'}).success).toBe(false);
  expect(draftSchema.safeParse({...article,approved:true}).success).toBe(false);
  expect(draftSchema.safeParse({...article,products:['carebase','carebase']}).success).toBe(false);
  expect(commandSchema.safeParse({operation:'execute',command:'ffmpeg'}).success).toBe(false);
 });
 it('requires each declared private asset to match a used scene or narration reference',()=>{
  const video={...article,kind:'video',markdown:'',assets:[image],scenes:[{order:1,title:'Welcome',type:'intro',durationSeconds:3,narration:'Welcome.',captionText:'Welcome.',screenshotAssetId:image.id}]};
  expect(draftSchema.safeParse(video).success).toBe(true);
  expect(draftSchema.safeParse({...video,assets:[]}).success).toBe(false);
  expect(draftSchema.safeParse({...video,narrationAssetId:image.id}).success).toBe(false);
  expect(draftSchema.safeParse({...video,assets:[image,{...image,id:'22345678-1234-4234-8234-123456789012'}]}).success).toBe(false);
  expect(draftSchema.safeParse({...video,scenes:[{...video.scenes[0],order:2}]}).success).toBe(false);
 });
 it('requires bounded drafts and an exact revision and request identity for a write review',()=>{
  const create={operation:'create',requestId:crypto.randomUUID(),projectId:crypto.randomUUID(),expectedRevision:0,draft:article};
  expect(commandSchema.safeParse(create).success).toBe(true);
  expect(commandSchema.safeParse({...create,expectedRevision:1}).success).toBe(false);
  expect(commandSchema.safeParse({...create,role:'platform_admin'}).success).toBe(false);
  expect(draftSchema.safeParse({...article,markdown:' '}).success).toBe(false);
 });
});
