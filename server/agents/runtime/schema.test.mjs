import { describe, expect, it } from 'vitest';
import { schemaDefects, schemaProblems } from './schema.mjs';

const schema = {
  type: 'object', additionalProperties: false, required: ['category', 'urgent', 'tags'],
  properties: {
    category: { type: 'string', enum: ['billing', 'general'] },
    urgent: { type: 'boolean' },
    count: { type: 'integer' },
    score: { type: 'number' },
    note: { type: 'null' },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
  },
};

describe('the closed schema subset', () => {
  it('accepts a schema that uses only the allowed keywords and closes every object', () => {
    expect(schemaDefects(schema)).toEqual([]);
    expect(schemaDefects({ type: 'object', additionalProperties: false, properties: { inner: { type: 'object', additionalProperties: false, properties: {} } } })).toEqual([]);
  });

  it('names what is wrong with a schema before anything is sent', () => {
    expect(schemaDefects(undefined)).toEqual(['$: not an object']);
    expect(schemaDefects([])).toEqual(['$: not an object']);
    expect(schemaDefects({ type: 'object', properties: {} })).toContain('$: an object must set additionalProperties to false');
    expect(schemaDefects({ type: 'object', additionalProperties: false, properties: { a: { type: 'string', maxLength: 10 } } })).toContain('$.a: keyword maxLength is not allowed');
    expect(schemaDefects({ type: 'object', additionalProperties: false, properties: { a: { type: 'integer', minimum: 0 } } })).toContain('$.a: keyword minimum is not allowed');
    expect(schemaDefects({ type: 'object', additionalProperties: false, properties: {}, required: ['missing'] })).toContain('$: required missing is not a property');
    expect(schemaDefects({ type: 'thing' })[0]).toMatch(/type must be one of/);
    expect(schemaDefects({ type: 'string', enum: [] })).toContain('$: enum must be a non-empty list');
    expect(schemaDefects({ type: 'array' })).toEqual(['$[]: not an object']);
    expect(schemaDefects({ type: 'object', additionalProperties: false, properties: { deep: { type: 'object', properties: {} } } })).toContain('$.deep: an object must set additionalProperties to false');
  });

  it('accepts a value that fits', () => {
    expect(schemaProblems(schema, { category: 'billing', urgent: false, tags: ['a', 'b'], count: 3, score: 1.5, note: null })).toEqual([]);
    expect(schemaProblems(schema, { category: 'general', urgent: true, tags: [] })).toEqual([]);
  });

  it('reports each place a value does not fit, as a path and never as the value', () => {
    const secret = 'Pat Example, 555-0100';
    expect(schemaProblems(schema, { category: secret, urgent: false, tags: [] })).toEqual(['$.category: not an allowed value']);
    expect(schemaProblems(schema, { category: 'general', urgent: 'yes', tags: [] })).toEqual(['$.urgent: wrong type']);
    expect(schemaProblems(schema, { category: 'general', urgent: true })).toEqual(['$.tags: missing']);
    expect(schemaProblems(schema, { category: 'general', urgent: true, tags: [], extra: secret })).toEqual(['$.extra: not allowed']);
    expect(schemaProblems(schema, { category: 'general', urgent: true, tags: ['a', secret, 'b'] })).toEqual(['$.tags[1]: not an allowed value']);
    expect(schemaProblems(schema, { category: 'general', urgent: true, tags: 'a' })).toEqual(['$.tags: wrong type']);
    expect(schemaProblems(schema, { category: 'general', urgent: true, tags: [], count: 1.5 })).toEqual(['$.count: wrong type']);
    expect(schemaProblems(schema, { category: 'general', urgent: true, tags: [], score: Number.NaN })).toEqual(['$.score: wrong type']);
    expect(schemaProblems(schema, null)).toEqual(['$: wrong type']);
    expect(schemaProblems(schema, [])).toEqual(['$: wrong type']);
    expect(JSON.stringify(schemaProblems(schema, { category: secret, urgent: false, tags: [secret], extra: secret }))).not.toContain('Pat Example');
  });

  it('does not treat inherited object names as fields', () => {
    expect(schemaProblems(schema, JSON.parse('{"category":"general","urgent":true,"tags":[],"constructor":1,"__proto__":2}')).sort())
      .toEqual(['$.__proto__: not allowed', '$.constructor: not allowed']);
    expect(schemaDefects({ type: 'object', additionalProperties: false, properties: {}, required: ['toString'] })).toEqual(['$: required toString is not a property']);
  });
});
