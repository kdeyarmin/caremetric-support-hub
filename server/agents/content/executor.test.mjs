import { describe, expect, it, vi } from 'vitest';
import { actionExecutor } from '../actions.mjs';
import { contentExecutors, contentFeature } from './executor.mjs';
import { fireDrillDraft } from './fixtures.mjs';
import { topics } from './topics.mjs';
import { checkDraft } from './validate.mjs';

const article = checkDraft(fireDrillDraft, { topic: topics.find(topic => topic.key === 'pa-fire-drill-requirements'), promptVersion: 'content.1' }).article;
const execution = (over = {}) => ({
  id: 'a1', agentKey: 'content_marketer', taskId: 't1', kind: 'content.publish', targetKind: 'content_item', targetId: article.slug,
  input: article, requestKey: 'r1', autoApproved: false, execution: 1, ...over,
});
const fixture = (answer = { outcome: 'published', slug: article.slug, itemId: 'i1', revisionId: 'v1' }) => {
  const logs = [];
  const store = { contentPublish: vi.fn(async () => (answer instanceof Error ? Promise.reject(answer) : answer)) };
  const executors = contentExecutors({ store, features: new Set([contentFeature]), log: line => logs.push(line) });
  return { store, logs, publish: executors['content.publish'] };
};

describe('publishing an approved article', () => {
  it('is available only when the database declares the feature', () => {
    for (const features of [undefined, null, new Set(), new Set(['platform.agents.v1']), 'platform.agents.content.v1']) {
      expect(contentExecutors({ store: {}, features }), String(features)).toEqual({});
    }
    expect(Object.keys(contentExecutors({ store: {}, features: [contentFeature] }))).toEqual(['content.publish']);
    expect(fixture().publish.requiresSession).toBeUndefined();
  });

  it('asks the database to publish the action it is carrying out and answers with the article\'s address', async () => {
    const { publish, store } = fixture();
    expect(await publish(execution())).toEqual({ outcome: 'published', slug: article.slug, url: `https://help.caremetric.ai/help/articles/${article.slug}` });
    expect(store.contentPublish).toHaveBeenCalledWith('a1', 1);
  });

  it('answers with the Intel address for an Intel article, and its help-center copy', async () => {
    const intel = { ...article, product: 'caremetric-intel', kind: 'marketing', body: article.body.replace(/\n\n\*[^*]+\*$/, '').replaceAll('CareBase', 'Intel') };
    const { publish } = fixture();
    expect(await publish(execution({ input: intel }))).toEqual({ outcome: 'published', slug: article.slug,
      url: `https://www.caremetricintel.com/resources/${article.slug}`, helpUrl: `https://help.caremetric.ai/help/articles/${article.slug}` });
  });

  it('treats an address that already holds this agent\'s article as done, with nothing new written', async () => {
    const { publish } = fixture({ outcome: 'already_published', slug: article.slug, itemId: 'i1' });
    expect(await publish(execution({ execution: undefined }))).toEqual({ outcome: 'already_published', slug: article.slug, url: `https://help.caremetric.ai/help/articles/${article.slug}` });
  });

  it('turns each refusal into a code the owner sees', async () => {
    for (const outcome of ['slug_taken', 'product_unavailable', 'approval_required']) {
      await expect(fixture({ outcome, slug: article.slug }).publish(execution()), outcome).rejects.toMatchObject({ code: outcome });
    }
    await expect(fixture({ outcome: 'surprise' }).publish(execution())).rejects.toMatchObject({ code: 'publish_failed' });
    await expect(fixture(null).publish(execution())).rejects.toMatchObject({ code: 'publish_failed' });
  });

  it('never publishes an article that was approved on its own', async () => {
    const { publish, store } = fixture();
    await expect(publish(execution({ autoApproved: true }))).rejects.toMatchObject({ code: 'approval_required' });
    expect(store.contentPublish).not.toHaveBeenCalled();
  });

  it('lets the database decide an article approved on its own once publishing can be handed over', async () => {
    const store = { contentPublish: vi.fn(async () => ({ outcome: 'published', slug: article.slug })) };
    const { 'content.publish': handed } = contentExecutors({ store, features: new Set(['platform.agents.content.v1', 'platform.agents.content-autopublish.v1']), log: () => {} });
    expect(await handed(execution({ autoApproved: true }))).toMatchObject({ outcome: 'published', slug: article.slug });
    expect(store.contentPublish).toHaveBeenCalledWith('a1', 1);
    store.contentPublish.mockResolvedValueOnce({ outcome: 'approval_required' });
    await expect(handed(execution({ autoApproved: true }))).rejects.toMatchObject({ code: 'approval_required' });
  });

  it('checks the stored article again and refuses one that fails, logging the checks and never the text', async () => {
    const { publish, store, logs } = fixture();
    const tampered = { ...article, body: `${article.body}\n\nCareBase ensures compliance. <script>alert(1)</script>` };
    await expect(publish(execution({ input: tampered }))).rejects.toMatchObject({ code: 'invalid_article' });
    expect(store.contentPublish).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual({ event: 'hub_content_publish_refused', action_id: 'a1', reasons: ['compliance_assurance', 'html'] });
  });

  it('settles the action as executed or failed with that code through the action executor', async () => {
    const settle = async answer => {
      const { publish } = fixture(answer);
      const store = {
        beginExecution: vi.fn(async () => execution()),
        completeExecution: vi.fn(async () => undefined),
      };
      const outcome = await actionExecutor({ store, executors: { 'content.publish': publish }, log: () => {} }).executeOne('a1', { kind: 'content.publish' });
      return { outcome, recorded: store.completeExecution.mock.calls[0] };
    };
    const done = await settle({ outcome: 'published', slug: article.slug });
    expect(done.outcome).toEqual({ executed: true, failed: false, skipped: false });
    expect(done.recorded).toEqual(['a1', true, { outcome: 'published', slug: article.slug, url: `https://help.caremetric.ai/help/articles/${article.slug}` }, 1]);
    const taken = await settle({ outcome: 'slug_taken', slug: article.slug });
    expect(taken.outcome).toEqual({ executed: false, failed: true, skipped: false, error: 'slug_taken' });
    expect(taken.recorded).toEqual(['a1', false, { error: 'slug_taken' }, 1]);
  });
});
