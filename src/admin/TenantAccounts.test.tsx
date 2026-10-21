// @vitest-environment jsdom
import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {TenantAccounts} from './TenantAccounts';
import {newTenantSchema,parseDollars,priceLabel,recordedMonthlyCents,slugify,subscriptionRecordSchema,tenantAccountsClient,type SubscriptionPricing,type TenantAccount} from './tenantAccountsModel';

const today='2026-10-21';
const carebase={id:'00000000-0000-4000-8000-000000000001',slug:'carebase',name:'CareMetric CareBase',status:'active'};
const breathe={id:'00000000-0000-4000-8000-000000000002',slug:'breathe',name:'CareMetric Breathe',status:'active'};
const pennsync={id:'00000000-0000-4000-8000-000000000003',slug:'pennsync',name:'PennSync',status:'pilot'};
const paid:SubscriptionPricing={plan_name:'Agency',price_cents:49900,billing_interval:'month',complimentary:false,complimentary_reason:'',complimentary_until:'',notes:'',version:3,updated_at:'2026-10-20T00:00:00Z'};
const tenant:TenantAccount={id:'11111111-1111-4111-8111-111111111111',slug:'keystone-home-health',name:'Keystone Home Health',industry:'Home health',status:'active',
  created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-20T12:00:00.123456+00:00',linked:true,member_count:2,subscriptions:[
    {product_id:breathe.id,product_slug:'breathe',product_name:breathe.name,access_status:'active',pricing:{...paid,plan_name:'Pilot',price_cents:120000,billing_interval:'year',complimentary:true,complimentary_reason:'Launch partner',complimentary_until:'2027-01-31',version:1}},
    {product_id:carebase.id,product_slug:'carebase',product_name:carebase.name,access_status:'active',pricing:paid},
  ]};
const unpriced:TenantAccount={...tenant,id:'22222222-2222-4222-8222-222222222222',slug:'support-22222222',name:'Allegheny Hospice',industry:'',linked:false,member_count:1,
  subscriptions:[{product_id:pennsync.id,product_slug:'pennsync',product_name:pennsync.name,access_status:'active',pricing:null}]};
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.open=true;};});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const setup=(tenants=[tenant,unpriced])=>{
  const client={list:vi.fn(async()=>({tenants,products:[breathe,carebase,pennsync],loaded_at:'2026-10-21T00:00:00Z'})),
    create:vi.fn(async()=>({...tenant,id:'33333333-3333-4333-8333-333333333333',name:'Juniata Valley Care',slug:'juniata-valley-care'})),
    saveTenant:vi.fn(async()=>({...tenant,status:'suspended' as const})),saveSubscription:vi.fn(async()=>tenant)};
  render(<TenantAccounts client={client} demo={false} today={today}/>);return client;
};

describe('tenant workspace',()=>{
  it('shows each subscription price, complimentary period and missing pricing honestly',async()=>{
    setup();await screen.findByRole('heading',{name:'Keystone Home Health'});
    const keystone=within(screen.getByRole('list',{name:'Keystone Home Health applications'}));
    expect(keystone.getByText('$499.00 per month')).toBeTruthy();
    expect(keystone.getByText('Complimentary (free) until Jan 31, 2027, then $1,200.00 per year')).toBeTruthy();
    expect(screen.getByText('Linked to an app account')).toBeTruthy();
    expect(within(screen.getByRole('list',{name:'Allegheny Hospice applications'})).getByText('No pricing recorded')).toBeTruthy();
    const summary=within(screen.getByLabelText('Tenant summary'));
    expect(summary.getByText('$499.00')).toBeTruthy();
    expect(summary.getByText('Complimentary subscriptions').previousSibling?.textContent).toBe('1');
  });
  it('filters by complimentary or missing pricing and searches plans and applications',async()=>{
    setup();await screen.findByRole('heading',{name:'Keystone Home Health'});
    fireEvent.change(screen.getByLabelText('Show'),{target:{value:'unpriced'}});
    expect(screen.queryByRole('heading',{name:'Keystone Home Health'})).toBeNull();
    expect(screen.getByRole('heading',{name:'Allegheny Hospice'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Show'),{target:{value:'complimentary'}});
    expect(screen.getByRole('heading',{name:'Keystone Home Health'})).toBeTruthy();
    expect(screen.queryByRole('heading',{name:'Allegheny Hospice'})).toBeNull();
    fireEvent.change(screen.getByLabelText('Show'),{target:{value:'all'}});
    fireEvent.change(screen.getByLabelText('Search tenants'),{target:{value:'pennsync'}});
    expect(screen.getByRole('heading',{name:'Allegheny Hospice'})).toBeTruthy();
    expect(screen.queryByRole('heading',{name:'Keystone Home Health'})).toBeNull();
  });
  it('sets up a tenant with a derived slug and a yearly price',async()=>{
    const client=setup();await screen.findByRole('heading',{name:'Keystone Home Health'});
    fireEvent.click(screen.getByRole('button',{name:'Set up tenant'}));
    const dialog=within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Tenant name'),{target:{value:'Juniata Valley Care'}});
    expect((dialog.getByLabelText('Slug') as HTMLInputElement).value).toBe('juniata-valley-care');
    fireEvent.change(dialog.getByLabelText('First application'),{target:{value:carebase.id}});
    fireEvent.change(dialog.getByLabelText('Plan name'),{target:{value:'Enterprise'}});
    fireEvent.change(dialog.getByLabelText('Price (USD)'),{target:{value:'$1,299.50'}});
    fireEvent.change(dialog.getByLabelText('Billed per'),{target:{value:'year'}});
    fireEvent.click(dialog.getByRole('button',{name:'Create tenant'}));
    await waitFor(()=>expect(client.create).toHaveBeenCalledWith({name:'Juniata Valley Care',slug:'juniata-valley-care',industry:'',subscriptions:[
      {product_id:carebase.id,access_status:'active',plan_name:'Enterprise',price_cents:129950,billing_interval:'year',complimentary:false,complimentary_reason:'',complimentary_until:'',notes:''}]}));
    await screen.findByText('Juniata Valley Care is set up.');
  });
  it('sets up a complimentary tenant, or one with applications added later',async()=>{
    const client=setup();await screen.findByRole('heading',{name:'Keystone Home Health'});
    fireEvent.click(screen.getByRole('button',{name:'Set up tenant'}));
    let dialog=within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Tenant name'),{target:{value:'Free Pilot Agency'}});
    fireEvent.change(dialog.getByLabelText('Plan name'),{target:{value:'Pilot'}});
    fireEvent.click(dialog.getByLabelText('Complimentary (free)'));
    fireEvent.click(dialog.getByRole('button',{name:'Create tenant'}));
    expect((await dialog.findByRole('alert')).textContent).toBe('Record why the subscription is complimentary.');
    fireEvent.change(dialog.getByLabelText('Why it is complimentary'),{target:{value:'Design partner'}});
    fireEvent.click(dialog.getByRole('button',{name:'Create tenant'}));
    await waitFor(()=>expect(client.create).toHaveBeenCalledWith(expect.objectContaining({slug:'free-pilot-agency',subscriptions:[expect.objectContaining({product_id:breathe.id,price_cents:0,complimentary:true,complimentary_reason:'Design partner'})]})));
    fireEvent.click(await screen.findByRole('button',{name:'Set up tenant'}));
    dialog=within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Tenant name'),{target:{value:'Later Agency'}});
    fireEvent.change(dialog.getByLabelText('First application'),{target:{value:''}});
    expect(dialog.queryByLabelText('Plan name')).toBeNull();
    fireEvent.click(dialog.getByRole('button',{name:'Create tenant'}));
    await waitFor(()=>expect(client.create).toHaveBeenLastCalledWith({name:'Later Agency',slug:'later-agency',industry:'',subscriptions:[]}));
  });
  it('refuses reserved slugs and paid subscriptions without a price before sending',async()=>{
    const client=setup();await screen.findByRole('heading',{name:'Keystone Home Health'});
    fireEvent.click(screen.getByRole('button',{name:'Set up tenant'}));
    const dialog=within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Tenant name'),{target:{value:'Support Partners'}});
    fireEvent.change(dialog.getByLabelText('Plan name'),{target:{value:'Agency'}});
    fireEvent.change(dialog.getByLabelText('Price (USD)'),{target:{value:'0'}});
    fireEvent.click(dialog.getByRole('button',{name:'Create tenant'}));
    expect((await dialog.findByRole('alert')).textContent).toBe('Enter a price, or make the subscription complimentary.');
    fireEvent.change(dialog.getByLabelText('Price (USD)'),{target:{value:'49.999'}});
    fireEvent.click(dialog.getByRole('button',{name:'Create tenant'}));
    expect(dialog.getByRole('alert').textContent).toMatch(/Enter a price in dollars/);
    fireEvent.change(dialog.getByLabelText('Price (USD)'),{target:{value:'49'}});
    fireEvent.click(dialog.getByRole('button',{name:'Create tenant'}));
    expect(dialog.getByRole('alert').textContent).toMatch(/reserved for app onboarding/);
    expect(client.create).not.toHaveBeenCalled();
  });
  it('makes a paid subscription free with the version last read and keeps its regular price',async()=>{
    const client=setup();await screen.findByRole('heading',{name:'Keystone Home Health'});
    fireEvent.click(screen.getByRole('button',{name:'Edit pricing for CareMetric CareBase at Keystone Home Health'}));
    const dialog=within(screen.getByRole('dialog'));
    expect((dialog.getByLabelText('Price (USD)') as HTMLInputElement).value).toBe('499.00');
    fireEvent.click(dialog.getByLabelText('Complimentary (free)'));
    expect(dialog.getByLabelText('Regular price (USD)')).toBeTruthy();
    fireEvent.change(dialog.getByLabelText('Why it is complimentary'),{target:{value:'Service credit'}});
    fireEvent.change(dialog.getByLabelText('Free until (optional)'),{target:{value:'2026-12-31'}});
    fireEvent.click(dialog.getByRole('button',{name:'Save subscription'}));
    await waitFor(()=>expect(client.saveSubscription).toHaveBeenCalledWith(tenant,carebase.id,
      {access_status:'active',plan_name:'Agency',price_cents:49900,billing_interval:'month',complimentary:true,complimentary_reason:'Service credit',complimentary_until:'2026-12-31',notes:''},paid));
    await screen.findByText('Subscription saved.');
  });
  it('returns a complimentary subscription to paid and clears its free terms',async()=>{
    const client=setup();await screen.findByRole('heading',{name:'Keystone Home Health'});
    fireEvent.click(screen.getByRole('button',{name:'Edit pricing for CareMetric Breathe at Keystone Home Health'}));
    const dialog=within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByLabelText('Paid subscription'));
    fireEvent.change(dialog.getByLabelText('Price (USD)'),{target:{value:'1500'}});
    fireEvent.click(dialog.getByRole('button',{name:'Save subscription'}));
    await waitFor(()=>expect(client.saveSubscription).toHaveBeenCalledWith(tenant,breathe.id,
      expect.objectContaining({complimentary:false,complimentary_reason:'',complimentary_until:'',price_cents:150000,billing_interval:'year'}),tenant.subscriptions[0].pricing));
  });
  it('refuses a new complimentary end date in the past',async()=>{
    const client=setup();await screen.findByRole('heading',{name:'Keystone Home Health'});
    fireEvent.click(screen.getByRole('button',{name:'Edit pricing for CareMetric Breathe at Keystone Home Health'}));
    const dialog=within(screen.getByRole('dialog'));
    const until=dialog.getByLabelText('Free until (optional)') as HTMLInputElement;
    expect(until.min).toBe(today);
    fireEvent.change(until,{target:{value:'2026-10-20'}});
    expect(until.validity.rangeUnderflow).toBe(true);
    fireEvent.click(dialog.getByRole('button',{name:'Save subscription'}));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(client.saveSubscription).not.toHaveBeenCalled();
  });
  it('records pricing for access created by onboarding as a new version',async()=>{
    const client=setup();await screen.findByRole('heading',{name:'Allegheny Hospice'});
    fireEvent.click(screen.getByRole('button',{name:'Set pricing for PennSync at Allegheny Hospice'}));
    const dialog=within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Plan name'),{target:{value:'Sync'}});
    fireEvent.change(dialog.getByLabelText('Price (USD)'),{target:{value:'89'}});
    fireEvent.click(dialog.getByRole('button',{name:'Save subscription'}));
    await waitFor(()=>expect(client.saveSubscription).toHaveBeenCalledWith(unpriced,pennsync.id,expect.objectContaining({price_cents:8900,complimentary:false}),null));
  });
  it('adds only applications the tenant does not have yet',async()=>{
    const client=setup();await screen.findByRole('heading',{name:'Allegheny Hospice'});
    expect((screen.getByRole('button',{name:'Add an application to Keystone Home Health'}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'Add an application to Allegheny Hospice'}));
    const dialog=within(screen.getByRole('dialog'));
    expect(dialog.getAllByRole('option').map(option=>option.textContent).slice(0,2)).toEqual(['CareMetric Breathe','CareMetric CareBase']);
    expect(dialog.queryByRole('option',{name:'PennSync'})).toBeNull();
    fireEvent.change(dialog.getByLabelText('Application'),{target:{value:carebase.id}});
    fireEvent.change(dialog.getByLabelText('Plan name'),{target:{value:'Agency'}});
    fireEvent.change(dialog.getByLabelText('Price (USD)'),{target:{value:'499'}});
    fireEvent.click(dialog.getByRole('button',{name:'Save subscription'}));
    await waitFor(()=>expect(client.saveSubscription).toHaveBeenCalledWith(unpriced,carebase.id,expect.objectContaining({price_cents:49900}),null));
  });
  it('offers Add application only while a current application is missing, even beside a retired one',async()=>{
    const retired={product_id:'44444444-4444-4444-8444-444444444444',product_slug:'legacy',product_name:'Retired Legacy',access_status:'closed' as const,pricing:null};
    const full={...tenant,subscriptions:[...tenant.subscriptions,{...unpriced.subscriptions[0]}]};
    const partial={...unpriced,subscriptions:[...unpriced.subscriptions,retired,{...retired,product_id:'55555555-5555-4555-8555-555555555555'}]};
    setup([full,partial]);await screen.findByRole('heading',{name:'Keystone Home Health'});
    expect((screen.getByRole('button',{name:'Add an application to Keystone Home Health'}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:'Add an application to Allegheny Hospice'}) as HTMLButtonElement).disabled).toBe(false);
  });
  it('edits tenant status with the revision last read',async()=>{
    const client=setup();await screen.findByRole('heading',{name:'Keystone Home Health'});
    fireEvent.click(screen.getByRole('button',{name:'Edit Keystone Home Health'}));
    const dialog=within(screen.getByRole('dialog'));
    expect(dialog.getByText('keystone-home-health')).toBeTruthy();
    fireEvent.change(dialog.getByLabelText('Status'),{target:{value:'suspended'}});
    fireEvent.click(dialog.getByRole('button',{name:'Save tenant'}));
    await waitFor(()=>expect(client.saveTenant).toHaveBeenCalledWith(tenant,{name:'Keystone Home Health',industry:'Home health',status:'suspended'}));
    await screen.findByText('Tenant saved.');
    expect(screen.getAllByText('Suspended').length).toBeGreaterThan(0);
  });
  it('keeps unsaved edits visible after a conflict',async()=>{
    const client=setup();client.saveSubscription.mockRejectedValue(new Error('conflict'));
    await screen.findByRole('heading',{name:'Keystone Home Health'});
    fireEvent.click(screen.getByRole('button',{name:'Edit pricing for CareMetric CareBase at Keystone Home Health'}));
    fireEvent.change(screen.getByLabelText('Price (USD)'),{target:{value:'549'}});
    fireEvent.click(screen.getByRole('button',{name:'Save subscription'}));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Price (USD)') as HTMLInputElement).value).toBe('549');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('does not show cached tenants after a failed refresh',async()=>{
    const client=setup();await screen.findByRole('heading',{name:'Keystone Home Health'});
    client.list.mockRejectedValue(new Error('forbidden'));fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
    await screen.findByRole('alert');expect(screen.queryByRole('heading',{name:'Keystone Home Health'})).toBeNull();
  });
  it('does not request private records in demo mode',()=>{
    const client={list:vi.fn(),create:vi.fn(),saveTenant:vi.fn(),saveSubscription:vi.fn()};
    render(<TenantAccounts client={client} demo/>);
    expect(client.list).not.toHaveBeenCalled();expect(screen.getByText(/Demo mode does not contain your tenants/)).toBeTruthy();
  });
});

describe('tenant pricing rules and transport',()=>{
  const record={access_status:'active' as const,plan_name:'Agency',price_cents:49900,billing_interval:'month' as const,complimentary:false,complimentary_reason:'',complimentary_until:'',notes:''};
  it('accepts paid or explained complimentary pricing only',()=>{
    expect(subscriptionRecordSchema.safeParse(record).success).toBe(true);
    expect(subscriptionRecordSchema.safeParse({...record,price_cents:0,complimentary:true,complimentary_reason:'Pilot'}).success).toBe(true);
    for(const change of [{price_cents:0},{price_cents:-1},{price_cents:100_000_001},{price_cents:1.5},{complimentary:true},{complimentary_reason:'Not free'},
      {complimentary:true,complimentary_reason:'Pilot',price_cents:0,complimentary_until:'2027-01-01'},{billing_interval:'week'},{stripe_price:'price_1'},{plan_name:' '}])
      expect(subscriptionRecordSchema.safeParse({...record,...change}).success).toBe(false);
  });
  it('parses dollars to whole cents and derives slugs',()=>{
    expect([parseDollars('499'),parseDollars('$1,299.5'),parseDollars('0.99'),parseDollars('1000000'),parseDollars('1000000.01'),parseDollars('12.345'),parseDollars('-5'),parseDollars('')])
      .toEqual([49900,129950,99,100_000_000,null,null,null,null]);
    expect(slugify('  Saint Mary’s Home Health & Hospice, Inc. ')).toBe('saint-mary-s-home-health-hospice-inc');
    expect(slugify('Café Agency')).toBe('cafe-agency');
    expect(newTenantSchema.safeParse({name:'Support Co',slug:'support-co',industry:'',subscriptions:[]}).success).toBe(false);
    expect(newTenantSchema.safeParse({name:'Agency',slug:'agency',industry:'',subscriptions:[]}).success).toBe(true);
  });
  it('labels complimentary periods by date and counts only paid use in the monthly value',()=>{
    const free={...paid,complimentary:true,complimentary_reason:'Pilot',complimentary_until:'2026-10-21'};
    expect(priceLabel(free,'2026-10-21')).toBe('Complimentary (free) until Oct 21, 2026, then $499.00 per month');
    expect(priceLabel(free,'2026-10-22')).toBe('$499.00 per month · complimentary period ended Oct 21, 2026');
    expect(priceLabel({...free,complimentary_until:'',price_cents:0},'2026-10-22')).toBe('Complimentary (free)');
    expect(priceLabel(null,'2026-10-22')).toBe('No pricing recorded');
    expect(recordedMonthlyCents([tenant,unpriced],'2026-10-21')).toBe(49900);
    expect(recordedMonthlyCents([tenant],'2027-02-01')).toBe(49900+10000);
    expect(recordedMonthlyCents([{...tenant,status:'suspended'}],'2027-02-01')).toBe(0);
  });
  it('sends closed payloads with the expected version and revision through the same-origin API',async()=>{
    const fetcher=vi.fn(async()=>Response.json(tenant));vi.stubGlobal('fetch',fetcher);
    await tenantAccountsClient.saveSubscription(tenant,carebase.id,record,paid);
    expect(fetcher).toHaveBeenCalledWith('/api/rpc/save_tenant_subscription',expect.objectContaining({credentials:'same-origin',
      body:JSON.stringify({p_tenant_id:tenant.id,p_product_id:carebase.id,p_record:record,p_expected_version:3})}));
    await tenantAccountsClient.saveSubscription(unpriced,pennsync.id,record,null);
    expect(fetcher).toHaveBeenNthCalledWith(2,'/api/rpc/save_tenant_subscription',expect.objectContaining({body:expect.stringContaining('"p_expected_version":0}')}));
    await tenantAccountsClient.saveTenant(tenant,{name:'Keystone',industry:'',status:'closed'});
    expect(fetcher).toHaveBeenLastCalledWith('/api/rpc/save_tenant',expect.objectContaining({
      body:JSON.stringify({p_tenant_id:tenant.id,p_record:{name:'Keystone',industry:'',status:'closed'},p_expected_updated_at:tenant.updated_at})}));
    await expect(tenantAccountsClient.saveSubscription(tenant,carebase.id,{...record,price_cents:0},paid)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
