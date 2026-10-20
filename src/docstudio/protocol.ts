import { z } from 'zod';
import { PUBLICATION_PRODUCT_SLUGS } from '../imports/publicationImportPreview.ts';

export const id = z.uuid();
export const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !Array.from(value).some(char => {const code=char.charCodeAt(0);return code===127 || (code<32 && ![9,10,13].includes(code));}));
export const sceneSchema = z.object({order:z.number().int().min(1).max(120),title:text(180),type:z.enum(['intro','step','outro']),durationSeconds:z.number().int().min(3).max(120),narration:text(4000),captionText:text(2000),screenshotAssetId:id.optional()}).strict();
export const assetSchema = z.object({id,sha256:sha,byteLength:z.number().int().min(1).max(32*1024*1024),mediaType:z.enum(['image/png','image/jpeg','audio/mpeg','audio/wav'])}).strict();
export const draftSchema = z.object({
  kind:z.enum(['article','video']),title:text(180).min(2),summary:text(500),locale:z.literal('en-US'),accessLevel:z.enum(['public','customer','staff']),
  products:z.array(z.enum(PUBLICATION_PRODUCT_SLUGS)).min(1).max(PUBLICATION_PRODUCT_SLUGS.length),
  markdown:z.string().max(120000),scenes:z.array(sceneSchema).max(120),assets:z.array(assetSchema).max(40),narrationAssetId:id.optional(),
}).strict().superRefine((value,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:'custom',message});
  if(new Set(value.products).size!==value.products.length) fail('Choose each product once.');
  if(value.kind==='article') { if(!value.markdown.trim() || value.scenes.length || value.assets.length || value.narrationAssetId) fail('An article needs Markdown and no video assets.'); }
  else {
    if(value.markdown || !value.scenes.length || value.scenes.some((scene,index)=>scene.order!==index+1) || value.scenes.reduce((sum,scene)=>sum+scene.durationSeconds,0)>3600) fail('Use ordered video scenes totaling no more than one hour.');
    const references=value.scenes.flatMap(scene=>scene.screenshotAssetId?[scene.screenshotAssetId]:[]).concat(value.narrationAssetId?[value.narrationAssetId]:[]);
    if(new Set(value.assets.map(asset=>asset.id)).size!==value.assets.length || value.assets.reduce((sum,asset)=>sum+asset.byteLength,0)>32*1024*1024) fail('Assets must be unique and total at most 32 MiB.');
    if(value.assets.some(asset=>!references.includes(asset.id)) || references.some(ref=>!value.assets.some(asset=>asset.id===ref))) fail('Every attached asset must be used by this video.');
    if(value.scenes.some(scene=>scene.screenshotAssetId && !value.assets.find(asset=>asset.id===scene.screenshotAssetId)?.mediaType.startsWith('image/')) || (value.narrationAssetId && !value.assets.find(asset=>asset.id===value.narrationAssetId)?.mediaType.startsWith('audio/'))) fail('Select an image for a scene and audio for narration.');
  }
});
export type Draft = z.infer<typeof draftSchema>;
export const commandSchema = z.discriminatedUnion('operation',[
  z.object({operation:z.literal('create'),requestId:id,projectId:id,expectedRevision:z.literal(0),draft:draftSchema}).strict(),
  z.object({operation:z.literal('edit'),requestId:id,projectId:id,expectedRevision:z.number().int().min(1).max(99),draft:draftSchema}).strict(),
  ...(['submit','approve','render','cancel'] as const).map(operation=>z.object({operation:z.literal(operation),requestId:id,projectId:id,expectedRevision:z.number().int().min(1).max(100)}).strict()),
]);
export type Command = z.infer<typeof commandSchema>;
export const applySchema=z.object({intentId:id,requestId:id,reviewConfirmed:z.literal(true),phiConfirmed:z.boolean()}).strict();
export interface ProjectSummary {id:string;title:string;kind:'article'|'video';revision:number;status:'draft'|'in_review'|'approved';updatedAt:string}
export interface Job {id:string;revision:number;status:'queued'|'running'|'completed'|'failed'|'cancelled';progress:number;attempts:number;createdAt:string;outputCount:number}
export interface Project extends ProjectSummary {contentKey:string;draft:Draft;approvedAt:string|null;jobs:Job[];assets:z.infer<typeof assetSchema>[]}
export interface Readiness {products:{slug:typeof PUBLICATION_PRODUCT_SLUGS[number];name:string}[];projects:ProjectSummary[];nextCursor:{updatedAt:string;id:string}|null;workerReady:boolean;maxVideoBytes:number}
export interface Intent {id:string;requestId:string;operation:Command['operation'];projectId:string;expectedRevision:number;title:string;products:string[];expiresAt:string}
export interface Receipt {intentId:string;requestId:string;projectId:string;revision:number;operation:Command['operation'];jobId:string|null;appliedAt:string}
