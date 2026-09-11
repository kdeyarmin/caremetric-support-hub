// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupportReadiness } from './SupportReadiness';
import type { IntakeTenant, ReadinessClient } from './readiness';
// Registration has its own request and full HTTP/UI tests. Keep this fixture's
// network boundary explicit while exercising actual intake review behavior.
vi.mock('../lib/appSession',()=>({appRequest:vi.fn(async(path:string,body:{operation:string})=>{
  if(path==='admin/registration'&&body.operation==='list')return {rows:[],offset:0,total:0};
  throw new Error('Unexpected test request');
})}));
afterEach(cleanup);
const product={id:'00000000-0000-4000-8000-000000000001',slug:'caremetric-go',name:'CareMetric Go',status:'pilot' as const,supportEnabled:true,activeTenantCount:1,usableMemberCount:1,readyTenantCount:0,publishedItemCount:8};
const tenant:IntakeTenant={tenantId:'00000000-0000-4000-8000-000000000002',name:'Example customer',tenantStatus:'active',accessStatus:'active',enabled:false,updatedAt:null,usableMemberCount:1,ready:false};
const fixture=(rows=[tenant])=>({summary:vi.fn().mockResolvedValue({products:[product],loadedAt:'2026-09-11T18:30:00Z'}),tenants:vi.fn().mockResolvedValue({rows,total:rows.length,offset:0,limit:20}),set:vi.fn().mockResolvedValue({enabled:true})} satisfies ReadinessClient);
describe('customer support readiness',()=>{
  it('distinguishes guidance from empty customer onboarding and performs no mutation',async()=>{
    const client=fixture([]);render(<SupportReadiness client={client} demo={false}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Review CareMetric Go customer intake'}));
    expect(await screen.findByText(/No customer access is configured/)).toBeTruthy();expect(client.set).not.toHaveBeenCalled();
  });
  it('requires explicit review and sends the selected original revision only once',async()=>{
    const client=fixture();render(<SupportReadiness client={client} demo={false}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Review CareMetric Go customer intake'}));
    fireEvent.click(await screen.findByRole('button',{name:'Enable intake'}));
    const apply=screen.getByRole('button',{name:'Apply intake change'}) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);expect(client.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(apply);
    await waitFor(()=>expect(client.set).toHaveBeenCalledExactlyOnceWith(product.id,tenant,true));
  });
  it('prevents activation with no usable SMS member',async()=>{
    const client=fixture([{...tenant,usableMemberCount:0}]);render(<SupportReadiness client={client} demo={false}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Review CareMetric Go customer intake'}));
    expect((await screen.findByRole('button',{name:'Enable intake'}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/must finish SMS sign-in/)).toBeTruthy();expect(client.set).not.toHaveBeenCalled();
  });
  it('allows existing intake to be disabled when customer access is revoked',async()=>{
    const blocked={...tenant,enabled:true,usableMemberCount:0,accessStatus:'suspended'};
    const client=fixture([blocked]);render(<SupportReadiness client={client} demo={false}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Review CareMetric Go customer intake'}));
    fireEvent.click(await screen.findByRole('button',{name:'Disable intake'}));
    fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Apply intake change'}));
    await waitFor(()=>expect(client.set).toHaveBeenCalledExactlyOnceWith(product.id,blocked,false));
  });
  it('requires a new review after a rejected stale change',async()=>{
    const client=fixture();client.set.mockRejectedValue(new Error('Access changed'));
    render(<SupportReadiness client={client} demo={false}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Review CareMetric Go customer intake'}));
    fireEvent.click(await screen.findByRole('button',{name:'Enable intake'}));
    fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Apply intake change'}));
    expect((await screen.findByRole('alert')).textContent).toContain('Refresh readiness');
    expect(screen.queryByRole('checkbox')).toBeNull();expect(client.set).toHaveBeenCalledTimes(1);
  });
  it('does not claim readiness when the server fails',async()=>{
    const client=fixture();client.summary.mockRejectedValue(new Error('Connection unavailable'));
    render(<SupportReadiness client={client} demo={false}/>);
    expect((await screen.findByRole('alert')).textContent).toContain('Connection unavailable');
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('keeps demo mode visibly separate from live customer access',()=>{
    const client=fixture();render(<SupportReadiness client={client} demo/>);
    expect(screen.getByText(/Demo data does not establish/)).toBeTruthy();expect(client.summary).not.toHaveBeenCalled();
  });
});
