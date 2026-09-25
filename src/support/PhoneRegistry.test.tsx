// @vitest-environment jsdom
import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {PhoneRegistry} from './PhoneRegistry';
import {blankPhoneRecord,phoneRecordSchema,phoneRegistryClient,type PhoneRow} from './phoneRegistryModel';
const row:PhoneRow={...blankPhoneRecord,id:'11111111-1111-4111-8111-111111111111',number:'+12025550881',label:'Test support',provider:'Test',purpose:'Software support',version:1,updated_at:'2026-09-24T00:00:00Z'};
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.open=true;};});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const setup=(rows=[row])=>{
  const client={list:vi.fn(async()=>({rows,loaded_at:'2026-09-24T00:00:00Z'})),save:vi.fn(async()=>({...row,version:2}))};
  render(<MemoryRouter><PhoneRegistry client={client} demo={false}/></MemoryRouter>);return client;
};
describe('phone inventory',()=>{
  it('shows unknown usage honestly and searches formatted numbers',async()=>{
    setup();await screen.findByText('(202) 555-0881');
    expect(screen.getByText('Usage unknown')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search numbers'),{target:{value:'(202) 555-0881'}});
    expect(screen.getByRole('heading',{name:'(202) 555-0881'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search numbers'),{target:{value:'other provider'}});
    expect(screen.getByText('No numbers match your search.')).toBeTruthy();
  });
  it('saves edits with the original version and retains provider number',async()=>{
    const client=setup();await screen.findByText('(202) 555-0881');
    fireEvent.click(screen.getByRole('button',{name:'Edit (202) 555-0881'}));
    const dialog=screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('Phone number (international format)') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Purpose'),{target:{value:'Advisor reception'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Save number'}));
    await waitFor(()=>expect(client.save).toHaveBeenCalledWith(expect.objectContaining({purpose:'Advisor reception',number:row.number}),row));
    await screen.findByText('Phone number saved.');
  });
  it('keeps unsaved edits visible after a conflict',async()=>{
    const client=setup();client.save.mockRejectedValue(new Error('conflict'));
    await screen.findByText('(202) 555-0881');fireEvent.click(screen.getByRole('button',{name:'Edit (202) 555-0881'}));
    fireEvent.change(screen.getByLabelText('Purpose'),{target:{value:'New purpose'}});
    fireEvent.click(screen.getByRole('button',{name:'Save number'}));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Purpose') as HTMLInputElement).value).toBe('New purpose');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('does not show cached records after a failed refresh',async()=>{
    const client=setup();await screen.findByText('(202) 555-0881');
    client.list.mockRejectedValue(new Error('forbidden'));fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
    await screen.findByRole('alert');expect(screen.queryByText('(202) 555-0881')).toBeNull();
  });
  it('does not request private records in demo mode',()=>{
    const client={list:vi.fn(),save:vi.fn()};
    render(<MemoryRouter><PhoneRegistry client={client} demo/></MemoryRouter>);
    expect(client.list).not.toHaveBeenCalled();expect(screen.getByText(/Demo mode does not contain/)).toBeTruthy();
  });
});
describe('registry validation and transport',()=>{
  const record={...blankPhoneRecord,number:row.number,label:row.label,provider:row.provider,purpose:row.purpose};
  it('requires evidence and review date for usage claims',()=>{
    expect(phoneRecordSchema.safeParse({...record,usage_status:'observed'}).success).toBe(false);
    expect(phoneRecordSchema.safeParse({...record,usage_status:'observed',reviewed_on:'2026-09-24',evidence:'A completed call was observed.'}).success).toBe(true);
    for(const change of [{role:'platform_admin'},{notes:'x'.repeat(2001)},{reviewed_on:'2026-02-31'},{reviewed_on:'9999-01-01'},{number:'invalid'}])
      expect(phoneRecordSchema.safeParse({...record,...change}).success).toBe(false);
  });
  it('sends a closed update payload and optimistic version through same-origin API',async()=>{
    const fetcher=vi.fn(async()=>Response.json(row));vi.stubGlobal('fetch',fetcher);
    await phoneRegistryClient.save(record,row);
    expect(fetcher).toHaveBeenCalledWith('/api/rpc/save_phone_number',expect.objectContaining({credentials:'same-origin',body:JSON.stringify({p_id:row.id,p_record:record,p_expected_version:1})}));
  });
});

