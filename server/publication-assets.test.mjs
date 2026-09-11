import { describe,it,expect } from 'vitest';
import { spoolPublicationAsset,publicationRange } from './publication-assets.mjs';
import { fixtureManifest,articleBytes,videoBytes } from '../src/imports/publicationFixtures.ts';

describe('streamed publication assets',()=>{
  it('hashes fragmented exact bytes and streams them unchanged after verification',async()=>{
    const manifest=await fixtureManifest();
    const result=await spoolPublicationAsset(manifest,'primary',[articleBytes.slice(0,7),articleBytes.slice(7)],async asset=>{
      const bytes=new Uint8Array(await new Response(asset.stream()).arrayBuffer());
      expect(bytes).toEqual(articleBytes); expect(asset.bodyText).toContain('Workspace guide');
      return {sha256:asset.sha256,length:asset.byteLength};
    });
    expect(result).toEqual({sha256:manifest.artifact.sha256,length:articleBytes.length});
  });
  it('rejects short, long, changed and absent bytes before invoking storage',async()=>{
    const manifest=await fixtureManifest(); let calls=0;
    for(const source of [[],[articleBytes.slice(1)],[new Uint8Array(articleBytes.length+1)],[new Uint8Array(articleBytes.length)]]) {
      await expect(spoolPublicationAsset(manifest,'primary',source,async()=>{calls++;})).rejects.toBeDefined();
    }
    expect(calls).toBe(0);
  });
  it('accepts a supported small MP4 header without loading the movie as an arrayBuffer',async()=>{
    const manifest=await fixtureManifest('video');
    await spoolPublicationAsset(manifest,'primary',[videoBytes],async asset=>{expect(asset.bodyText).toBe(null); expect(asset.byteLength).toBe(24);});
  });
  it('preserves the original UTF-8 BOM for SQL byte/hash verification',async()=>{
    const bytes=new Uint8Array(3+articleBytes.length); bytes.set([239,187,191]); bytes.set(articleBytes,3);
    const manifest=await fixtureManifest(); manifest.artifact.byte_length=bytes.length;
    manifest.artifact.sha256=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
    await spoolPublicationAsset(manifest,'primary',[bytes],async asset=>{
      expect(asset.bodyText.charCodeAt(0)).toBe(0xfeff);
      expect(new TextEncoder().encode(asset.bodyText)).toEqual(bytes);
      expect(new Uint8Array(await new Response(asset.stream()).arrayBuffer())).toEqual(bytes);
    });
  });
  it('rejects dangerous text even when the exact digest is correct',async()=>{
    const bytes=new TextEncoder().encode('Read https://example.invalid/private');
    const manifest=await fixtureManifest();
    manifest.artifact.byte_length=bytes.length;
    const hash=await crypto.subtle.digest('SHA-256',bytes); manifest.artifact.sha256=Buffer.from(hash).toString('hex');
    await expect(spoolPublicationAsset(manifest,'primary',[bytes],async()=>{})).rejects.toMatchObject({status:422});
  });
});
describe('single publication byte ranges',()=>{
  it.each([['bytes=0-9',0,9],['bytes=10-',10,99],['bytes=-7',93,99],['bytes=0-999',0,99],['bytes=-999',0,99]])('normalizes %s',(header,start,end)=>{
    expect(publicationRange(header,100)).toEqual({start,end,header:`bytes=${start}-${end}`,length:end-start+1});
  });
  it.each(['bytes=','bytes=-0','bytes=100-','bytes=9-2','bytes=0-1,3-4','bytes=+1-2','items=0-1','bytes=99999999999-','bytes=1e2-','bytes=0-1\r\nX-Test: evil'])('denies invalid range %s',header=>{
    expect(()=>publicationRange(header,100)).toThrow();
  });
  it('distinguishes no range from malformed input',()=>{expect(publicationRange(null,100)).toBeNull(); expect(()=>publicationRange('',100)).toThrow();});
});
