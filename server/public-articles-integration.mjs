// The public article feed through the real roles: the Hub server reads a product's public articles with private.public_articles,
// exactly the published, public, everyone-audience articles whose every live publication is for that product, with no ids, authors,
// approvers or revision variables; drafts, customer articles, other audiences, future and expired publications, shared articles and
// other kinds are never returned; browser roles and any other session are refused. The feed module answers over the same read.
// Disposable loopback database only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { publicArticleFeed } from './public-articles.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const run = randomUUID().slice(0, 8);
const key = name => `feed-${run}-${name}`;
const keys = [];
const read = async product => (await pool.query('select private.public_articles($1) as articles', [product])).rows[0].articles;
const productId = async slug => (await admin.query('select id from hub.products where slug = $1', [slug])).rows[0].id;

/** One content item with an approved revision 1 and a publication per product. */
async function article(name, { products, kind = 'article', status = 'published', access = 'public', audience = ['all'], owner = products.length === 1 ? products[0] : null,
  publishedAt = "now() - interval '1 day'", expiresAt = 'null', title = `Feed article ${name}` }) {
  const contentKey = key(name);
  keys.push(contentKey);
  const item = (await admin.query(`insert into hub.content_items (content_key, kind, status, access_level, owner_product_id, owner_team, default_locale, source_system)
    values ($1, $2, $3, $4, $5, 'CareMetric Marketing', 'en-US', 'support_hub') returning id`, [contentKey, kind, status, access, owner])).rows[0].id;
  const revision = (await admin.query(`insert into hub.content_revisions (item_id, revision_no, locale, title, summary, body_markdown, variables, review_state, approved_at)
    values ($1, 1, 'en-US', $2, 'A description a visitor reads.', '**In short:** A summary.\n\nThe body.', '{"author": "content_marketer", "approvedBy": "secret"}'::jsonb, 'approved', now() - interval '2 days')
    returning id`, [item, title])).rows[0].id;
  for (const product of products) {
    await admin.query(`insert into hub.content_publications (item_id, revision_id, product_id, audience, published_at, expires_at)
      values ($1, $2, $3, $4, ${publishedAt}, ${expiresAt})`, [item, revision, product, audience]);
  }
  return { item, revision, contentKey };
}

try {
  const intel = await productId('caremetric-intel');
  const carebase = await productId('carebase');
  const intelState = (await admin.query('select status, support_enabled from hub.products where id = $1', [intel])).rows[0];
  assert.ok(intelState.status !== 'retired' && intelState.support_enabled, 'the seeded Intel product is open to support');

  const shown = await article('intel', { products: [intel] });
  await article('customer', { products: [intel], access: 'customer' });
  await article('draft', { products: [intel], status: 'draft' });
  await article('customers-only', { products: [intel], audience: ['customers'] });
  await article('future', { products: [intel], publishedAt: "now() + interval '1 day'" });
  await article('expired', { products: [intel], publishedAt: "now() - interval '3 days'", expiresAt: "now() - interval '1 day'" });
  await article('course', { products: [intel], kind: 'course' });
  await article('shared', { products: [intel, carebase] });
  await article('carebase', { products: [carebase] });
  // Ownership does not decide visibility (as in private.can_access_content_publication): an Intel-owned article also published to
  // CareBase is shared, and a CareBase-owned article published to Intel alone is Intel's.
  await article('owned-shared', { products: [intel, carebase], owner: intel });
  await article('owned-elsewhere', { products: [intel], owner: carebase });
  // A newer revision waiting for review is never shown: the publication still points at revision 1.
  await admin.query(`insert into hub.content_revisions (item_id, revision_no, locale, title, summary, body_markdown, review_state)
    values ($1, 2, 'en-US', 'An unreviewed draft title', 'Draft.', 'Draft body.', 'draft')`, [shown.item]);

  const ours = list => list.filter(item => item.key.startsWith(`feed-${run}-`));
  const intelList = ours(await read('caremetric-intel'));
  assert.deepEqual(intelList.map(item => item.key).sort(), [key('intel'), key('owned-elsewhere')].sort(), 'only the public, live articles that are Intel\'s alone');
  const only = intelList.find(item => item.key === key('intel'));
  assert.deepEqual(Object.keys(only).sort(), ['description', 'key', 'locale', 'markdown', 'publishedAt', 'revision', 'title', 'updatedAt']);
  assert.equal(only.title, 'Feed article intel');
  assert.equal(only.description, 'A description a visitor reads.');
  assert.equal(only.markdown, '**In short:** A summary.\n\nThe body.');
  assert.equal(only.revision, 1);
  assert.ok(!JSON.stringify(only).includes('secret') && !JSON.stringify(only).includes(shown.item), 'no ids or revision variables');
  assert.ok(Date.parse(only.updatedAt) >= Date.parse(only.publishedAt));
  assert.deepEqual(ours(await read('carebase')).map(item => item.key), [key('carebase')], 'a shared article is no single product\'s');
  assert.deepEqual(ours(await read('advisors')), []);

  // A product retired or closed to support takes its articles with it.
  await admin.query('update hub.products set support_enabled = false where id = $1', [carebase]);
  try { assert.deepEqual(ours(await read('carebase')), []); }
  finally { await admin.query('update hub.products set support_enabled = true where id = $1', [carebase]); }

  // A retired article leaves the feed.
  await admin.query("update hub.content_items set status = 'retired', retired_at = now() where id = $1", [shown.item]);
  assert.deepEqual(ours(await read('caremetric-intel')).map(item => item.key), [key('owned-elsewhere')]);
  await admin.query("update hub.content_items set status = 'published', retired_at = null where id = $1", [shown.item]);

  // Malformed products are refused; an unknown one is simply empty.
  await assert.rejects(read('Not A Product'), error => error?.code === '22023');
  assert.deepEqual(await read('no-such-product'), []);

  // Only the Hub server: the administrator session and the browser roles are refused.
  await assert.rejects(admin.query('select private.public_articles($1)', ['caremetric-intel']), error => error?.code === '42501');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      await assert.rejects(client.query('select private.public_articles($1)', ['caremetric-intel']), error => error?.code === '42501', role);
    } finally { await client.query('rollback'); client.release(); }
  }

  // The feed module over the real read.
  const feed = publicArticleFeed({ load: read, log: () => {} });
  const served = (await feed.articles('caremetric-intel')).filter(item => item.key === key('intel'));
  assert.deepEqual(served.map(item => [item.key, item.summary, item.body]), [[key('intel'), 'A summary.', 'The body.']]);
  console.log('Public article feed integration passed.');
} finally {
  await admin.query('delete from hub.content_publications where item_id in (select id from hub.content_items where content_key = any($1::text[]))', [keys]);
  await admin.query('delete from hub.content_revisions where item_id in (select id from hub.content_items where content_key = any($1::text[]))', [keys]);
  await admin.query('delete from hub.content_items where content_key = any($1::text[])', [keys]);
  await pool.end();
  await admin.end();
}
