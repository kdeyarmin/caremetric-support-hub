import { describe, expect, it } from 'vitest';
import { decidingTitle, pageLines, personName, teamLinks, teamPeople, titleRank } from './team.mjs';

describe('reading who leads a business from its own pages', () => {
  it('reads the visible text as lines, never a script or a comment', () => {
    expect(pageLines('<p>Jane <strong>Doe</strong></p><script>var owner = "Fake Person";</script><!-- Hidden Name --><div>Owner&nbsp;&amp; Founder</div>'))
      .toEqual(['Jane Doe', 'Owner & Founder']);
  });

  it('tells a person\'s name and a deciding title from the rest of a page', () => {
    expect(personName('Jane Doe, RN, BSN')).toBe('Jane Doe');
    expect(personName('Dr. Sam Lee')).toBe('Sam Lee');
    expect(personName('ALEX GREEN')).toBe('Alex Green');
    expect(personName('José Martínez')).toBe('José Martínez');
    for (const notAName of ['Patient Care', 'Our Mission', 'Read More', 'Valley Hospice', 'jane doe', 'Meet Jane', 'Director of Nursing']) expect(personName(notAName)).toBeNull();
    expect(decidingTitle('— Director of Business Development')).toBe('Director of Business Development');
    expect(decidingTitle('is our Administrator')).toBe('Administrator');
    expect(decidingTitle('Registered Nurse')).toBeNull();
    expect(decidingTitle('Chris Park (Community Liaison)')).toBeNull();
    expect(decidingTitle('We are proud to serve. Our administrator is here.')).toBeNull();
    expect([titleRank('Owner'), titleRank('Administrator'), titleRank('Nurse')]).toEqual([0, 2, Infinity]);
  });

  it('pairs each name with its title, on one line or on the line below', () => {
    const html = `<main><h1>Meet Our Team</h1>
      <div class="member"><h3>Jane Doe, RN, BSN</h3><p class="title">Administrator</p><a href="mailto:jdoe@valleyhospice.org">Email Jane</a></div>
      <div class="member"><h3>John Smith</h3><p>Director of Business Development</p></div>
      <div class="member"><h3>Patient Care</h3><p>Director of Nursing</p></div>
      <p>Mary Major – Owner &amp; Founder</p>
      <p>Executive Director: Sam Lee</p>
      <p>Chris Park (Community Liaison)</p>
      <ul><li>Pat Kim</li><li>Registered Nurse</li></ul>
      <strong>ALEX GREEN</strong><br><span>President</span>
      <script>document.write("Fake Person, Owner")</script></main>`;
    expect(teamPeople(html)).toEqual([
      { name: 'Jane Doe', title: 'Administrator' }, { name: 'John Smith', title: 'Director of Business Development' },
      { name: 'Mary Major', title: 'Owner & Founder' }, { name: 'Sam Lee', title: 'Executive Director' },
      { name: 'Chris Park', title: 'Community Liaison' }, { name: 'Alex Green', title: 'President' },
    ]);
  });

  it('follows only links on the business\'s own hosts that lead to its people, team pages first', () => {
    const hosts = ['valleyhospice.org', 'www.valleyhospice.org'];
    expect(teamLinks(['https://www.valleyhospice.org/about-us/', 'https://valleyhospice.org/our-team', 'https://valleyhospice.org/blog/team-news',
      'https://other.org/leadership', 'http://valleyhospice.org/staff', 'https://valleyhospice.org/services'], hosts))
      .toEqual(['/our-team', '/blog/team-news', '/about-us/']);
  });
});
