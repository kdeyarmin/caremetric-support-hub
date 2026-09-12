// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
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
  it('keeps shared routes usable without claiming an unavailable native connection',()=>{
    render(<MemoryRouter><AdminFunctionCatalog product="caremetric-emr" capabilities={null} onNavigate={vi.fn()}/></MemoryRouter>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link',{name:'Courses, creation and distribution'}).getAttribute('href')).toBe('/library');
    expect(screen.getByRole('link',{name:'Support cases'}).getAttribute('href')).toBe('/cases');
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
