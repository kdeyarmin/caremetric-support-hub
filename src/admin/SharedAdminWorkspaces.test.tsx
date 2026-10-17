// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';
import {afterEach,describe,expect,it} from 'vitest';
import {SharedAdminWorkspaces} from './SharedAdminWorkspaces';

afterEach(cleanup);
describe('shared owner workspaces',()=>{
  it('keeps every existing owner workspace inside the Hub',()=>{
    render(<MemoryRouter><SharedAdminWorkspaces/></MemoryRouter>);
    const navigation=screen.getByRole('navigation',{name:'Shared owner workspaces'});
    const expected=[
      ['Phone numbers and routing','/phone-numbers'],['AI phone inbox','/phone'],
      ['Support cases','/cases'],['Knowledge articles','/knowledge'],
      ['Courses, creation and distribution','/library'],['Create learning videos','/docstudio'],
      ['Review material imports','/imports/docstudio'],['Products and support contacts','/products'],
      ['Connections and customer onboarding','/integration'],['Account security','/security'],
      ['Support overview','/overview'],['Portfolio rollup','/admin/portfolio'],
      ['AI go-live readiness','/admin/go-live-readiness'],
    ];
    expect(within(navigation).getAllByRole('link')).toHaveLength(expected.length);
    for(const [name,path] of expected){
      const link=within(navigation).getByRole('link',{name});
      expect(link.getAttribute('href')).toBe(path);
      expect(link.getAttribute('target')).toBeNull();
    }
    expect(screen.getByText(/Each workspace checks its current permissions and configuration/)).toBeTruthy();
  });
  it('uses the existing Hub router when the owner opens a workspace',()=>{
    render(<MemoryRouter initialEntries={['/admin']}><Routes>
      <Route path="/admin" element={<SharedAdminWorkspaces/>}/>
      <Route path="/phone-numbers" element={<h1>Phone registry workspace</h1>}/>
    </Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('link',{name:'Phone numbers and routing'}));
    expect(screen.getByRole('heading',{name:'Phone registry workspace'})).toBeTruthy();
  });
});
