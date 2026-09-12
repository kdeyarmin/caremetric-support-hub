import {expect,it,vi} from 'vitest';
import {distributionSession} from './distribution-session.mjs';
const sessionToken='a'.repeat(43);
it('bounds pool acquisition and destroys a client arriving after request cancellation',async()=>{
 const controller=new AbortController(),release=vi.fn(),operation=vi.fn();let resolve;
 const pool={connect:()=>new Promise(done=>{resolve=done;})};const pending=distributionSession(pool,sessionToken,controller.signal,operation);
 controller.abort();await expect(pending).rejects.toMatchObject({status:503});resolve({release,query:vi.fn()});await Promise.resolve();await Promise.resolve();
 expect(release).toHaveBeenCalledExactlyOnceWith(true);expect(operation).not.toHaveBeenCalled();
});
it('destroys a stalled authorized phase before any commit and keeps cancellation bounded',async()=>{
 const controller=new AbortController(),release=vi.fn();let entered;
 const waiting=new Promise(done=>{entered=done;});
 const query=vi.fn(async sql=>{
  if(sql.startsWith('select s.id'))return {rows:[{id:'test-session',user_id:'test-user'}]};
  if(sql==='select stalled'){entered();return new Promise(()=>{});}return {rows:[]};
 });
 const pool={connect:async()=>({query,release})};const pending=distributionSession(pool,sessionToken,controller.signal,db=>db.query('select stalled'));
 await waiting;controller.abort();await expect(pending).rejects.toMatchObject({status:503});
 expect(release).toHaveBeenCalledExactlyOnceWith(true);expect(query.mock.calls.map(call=>call[0])).not.toContain('commit');
});
it('reuses actual SMS transaction authorization and releases one successful connection',async()=>{
 const controller=new AbortController(),release=vi.fn(),query=vi.fn(async sql=>({rows:sql.startsWith('select s.id')?[{id:'test-session',user_id:'test-user'}]:[]}));
 const value=await distributionSession({connect:async()=>({query,release})},sessionToken,controller.signal,async(_db,session)=>session.user_id);
 expect(value).toBe('test-user');expect(query.mock.calls.map(call=>call[0])).toContain('set local role authenticated');expect(query.mock.calls.at(-1)[0]).toBe('commit');expect(release).toHaveBeenCalledOnce();
});
