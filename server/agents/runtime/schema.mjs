/**
 * The small closed subset of JSON Schema the agents use for a model's structured answer. The
 * provider is asked to produce text that fits the schema, and this module checks that it did,
 * because the checks that matter (a closed set of values, no stray fields) are cheap and the
 * model's output is never trusted.
 *
 * Allowed: type (object, array, string, integer, number, boolean, null), enum (of strings, numbers,
 * booleans or null only), properties, required, items, description. Every object must say `additionalProperties: false`. Limits such
 * as minLength or maximum are not allowed: the provider does not enforce them, so a schema that
 * leaned on them would only look safe. Length and content limits belong in the agent's own
 * `validate`.
 *
 * Problems are reported as paths (`$.citations[2]`), never as values, because a value may be
 * customer text.
 */
const keywords = new Set(['type', 'enum', 'properties', 'required', 'items', 'description', 'additionalProperties']);
const types = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

/** The reasons a schema is not in the allowed subset (empty when it is). Checked when a run is requested, before any call. */
export function schemaDefects(schema, path = '$') {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [`${path}: not an object`];
  const defects = [];
  for (const key of Object.keys(schema)) if (!keywords.has(key)) defects.push(`${path}: keyword ${key} is not allowed`);
  if (!types.has(schema.type)) defects.push(`${path}: type must be one of ${[...types].join(', ')}`);
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) defects.push(`${path}: an object must set additionalProperties to false`);
    const properties = schema.properties ?? {};
    for (const [name, child] of Object.entries(properties)) defects.push(...schemaDefects(child, `${path}.${name}`));
    for (const name of schema.required ?? []) if (!Object.hasOwn(properties, name)) defects.push(`${path}: required ${name} is not a property`);
  }
  if (schema.type === 'array') defects.push(...schemaDefects(schema.items, `${path}[]`));
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) defects.push(`${path}: enum must be a non-empty list`);
  // An array or object member could never match a parsed answer (it is compared by identity), so the run would be paid for and then refused.
  else if (schema.enum !== undefined && schema.enum.some(member => member !== null && typeof member === 'object')) defects.push(`${path}: enum members must be strings, numbers, booleans or null`);
  return defects;
}

/** The places where `value` does not fit `schema`, as paths only (empty when it fits). */
export function schemaProblems(schema, value, path = '$') {
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const fits = schema.type === 'integer' ? Number.isInteger(value) : schema.type === 'number' ? kind === 'number' && Number.isFinite(value) : kind === schema.type;
  if (!fits) return [`${path}: wrong type`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: not an allowed value`];
  const problems = [];
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) problems.push(`${path}.${name}: missing`);
    for (const [name, child] of Object.entries(value)) {
      if (!Object.hasOwn(properties, name)) problems.push(`${path}.${name}: not allowed`);
      else problems.push(...schemaProblems(properties[name], child, `${path}.${name}`));
    }
  }
  if (schema.type === 'array') value.forEach((item, index) => problems.push(...schemaProblems(schema.items, item, `${path}[${index}]`)));
  return problems;
}
