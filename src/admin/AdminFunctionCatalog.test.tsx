// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AdminFunctionCatalog} from './AdminFunctionCatalog';
import {adminFunctions,functionAvailable} from './functionCatalog';
import type {PortfolioCapabilities} from '../../supabase/functions/_shared/portfolioProtocol';

afterEach(cleanup);
const capabilities=(operations:PortfolioCapabilities['operations']):PortfolioCapabilities=>({apiVersion:1,sourceRevision:null,operations});
describe('current administration function navigation',()=>{
  it('does not turn directory read access into a change control',()=>{
    const onNavigate=vi.fn();
    render(<MemoryRouter><AdminFunctionCatalog product="carebase" capabilities={capabilities(['organizations.list'])} onNavigate={onNavigate}/></MemoryRouter>);
    expect(screen.queryByRole('button',{name:'Open Organization access'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Open Organization directory'}));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('organizations');
  });
  it('requires all capabilities and the parent workspace for checkout',()=>{
    const checkout=adminFunctions.find(item=>item.id==='checkout')!;
    expect(functionAvailable(checkout,'carebase',capabilities([...checkout.requires]))).toBe(true);
    for(const missing of checkout.requires)expect(functionAvailable(checkout,'carebase',capabilities(checkout.requires.filter(operation=>operation!==missing)))).toBe(false);
    expect(functionAvailable(checkout,'breathe',capabilities([...checkout.requires]))).toBe(false);
  });
  it('requires invoice detail permission as well as the billing and list capabilities',()=>{
    const invoices=adminFunctions.find(item=>item.id==='invoices')!;
    expect(invoices.requires).toContain('billing.invoices.get');
    expect(functionAvailable(invoices,'carebase',capabilities([...invoices.requires]))).toBe(true);
    for(const missing of invoices.requires)expect(functionAvailable(invoices,'carebase',capabilities(invoices.requires.filter(operation=>operation!==missing)))).toBe(false);
    render(<MemoryRouter><AdminFunctionCatalog product="carebase" capabilities={capabilities(['billing.overview','billing.subscriptions.list','billing.invoices.list'])} onNavigate={vi.fn()}/></MemoryRouter>);
    expect(screen.queryByRole('button',{name:'Open Invoice records'})).toBeNull();
  });
  it('distinguishes product scope from missing capabilities on a verified connection',()=>{
    render(<MemoryRouter><AdminFunctionCatalog product="breathe" capabilities={capabilities(['organizations.list'])} onNavigate={vi.fn()}/></MemoryRouter>);
    const scoped=screen.getByText('Job stop controls').closest('li')!;
    expect(within(scoped).getByText('CareBase only')).toBeTruthy();
    expect(within(scoped).queryByText('Not connected for this app')).toBeNull();
    const unavailable=screen.getByText('User directory').closest('li')!;
    expect(within(unavailable).getByText('Not connected for this app')).toBeTruthy();
    expect(screen.getByRole('button',{name:'Open Organization directory'})).toBeTruthy();
  });
  it('keeps shared routes usable without claiming an unavailable native connection',()=>{
    render(<MemoryRouter><AdminFunctionCatalog product="caremetric-emr" capabilities={null} onNavigate={vi.fn()}/></MemoryRouter>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link',{name:'Courses, creation and distribution'}).getAttribute('href')).toBe('/library');
    expect(screen.getByRole('link',{name:'Support cases'}).getAttribute('href')).toBe('/cases');
    expect(screen.getByRole('link',{name:'Phone numbers and routing'}).getAttribute('href')).toBe('/phone-numbers');
    expect(screen.getByRole('link',{name:'AI phone inbox'}).getAttribute('href')).toBe('/phone');
    expect(screen.getByRole('status').textContent).toContain('connection is not verified');
  });
  it('searches both names and descriptions and opens only the reviewed workspace',()=>{
    const onNavigate=vi.fn();
    render(<MemoryRouter><AdminFunctionCatalog product="carebase" capabilities={capabilities(['operations.jobs.list','operations.config.v1'])} onNavigate={onNavigate}/></MemoryRouter>);
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'job stop'}});
    expect(screen.queryByText('Organization directory')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Open Job stop controls'}));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('jobs');
  });
});
