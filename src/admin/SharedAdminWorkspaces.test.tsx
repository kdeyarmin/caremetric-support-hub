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
      ['Control center: every app, channel and service','/admin'],['Applications: users, organizations, courses, training','/admin/apps'],
      ['Phone numbers and routing','/phone-numbers'],['AI phone inbox','/phone'],
      ['Communications: phone, text, email, chat','/communications'],['Support cases','/cases'],['Knowledge articles','/knowledge'],
      ['Courses, creation and distribution','/library'],
      ['Products and support contacts','/products'],
      ['Connections and customer onboarding','/integration'],['Account security','/security'],
      ['Support overview','/overview'],['Portfolio rollup','/admin/portfolio'],
      ['AI go-live readiness','/admin/go-live-readiness'],
    ];
    expect(within(navigation).getAllByRole('link')).toHaveLength(expected.length);
    expect(within(navigation).queryByRole('link',{name:'Create learning videos'})).toBeNull();
    for(const [name,path] of expected){
      const link=within(navigation).getByRole('link',{name});
      expect(link.getAttribute('href')).toBe(path);
      expect(link.getAttribute('target')).toBeNull();
    }
    expect(screen.getByText(/Each workspace checks its current permissions and configuration/)).toBeTruthy();
  });
  it('uses the existing Hub router when the owner opens a workspace',()=>{
    render(<MemoryRouter initialEntries={['/admin/apps']}><Routes>
      <Route path="/admin/apps" element={<SharedAdminWorkspaces/>}/>
      <Route path="/phone-numbers" element={<h1>Phone registry workspace</h1>}/>
    </Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('link',{name:'Phone numbers and routing'}));
    expect(screen.getByRole('heading',{name:'Phone registry workspace'})).toBeTruthy();
  });
});
