// Read-only release prerequisites. The production migration ledger uses application-time
// versions, so inspect the installed objects rather than compare repository filenames.
export const advertisingReleaseQuery = `
  select signature, pg_get_functiondef(to_regprocedure(signature)) as definition,
    coalesce(has_function_privilege('hub_app_server', to_regprocedure(signature), 'EXECUTE'), false) as server_execute,
    coalesce(has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE'), false)
      or coalesce(has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE'), false) as browser_execute
  from unnest(array['private.creative_live_assets(text[])', 'private.creative_brief_create(jsonb)']) as required(signature)
`;

export function missingAdvertisingPrerequisites(rows) {
  const snapshot = rows.find(row => row.signature === 'private.creative_live_assets(text[])');
  const brief = rows.find(row => row.signature === 'private.creative_brief_create(jsonb)');
  const protectedFunction = row => row?.server_execute === true && row.browser_execute === false
    && typeof row.definition === 'string' && row.definition.includes('private.require_hub_app_server()');
  const missing = [];
  const fields = { id: 'id', product: 'product', platform: 'platform', placement: 'placement', kind: 'kind', headline: 'headline',
    primaryText: 'primary_text', description: 'description', cta: 'cta', landingUrl: 'landing_url', token: 'public_token', status: 'status' };
  if (!protectedFunction(snapshot) || Object.entries(fields).some(([key, column]) =>
    !new RegExp(`'${key}'\\s*,\\s*a\\.${column}\\b`).test(snapshot.definition))
    || !/a\.status\s+in\s*\(\s*'approved'\s*,\s*'live'\s*\)/i.test(snapshot.definition)) missing.push('campaign_creative_validation');
  if (!protectedFunction(brief) || !/perform\s+private\.agent_task_enqueue\s*\(/i.test(brief.definition)) missing.push('creative_brief_queue_atomic');
  return missing;
}

export async function assertAdvertisingRelease(pool) {
  const { rows } = await pool.query(advertisingReleaseQuery);
  const missing = missingAdvertisingPrerequisites(rows);
  if (missing.length) throw new Error(`Advertising database prerequisites missing: ${missing.join(', ')}. Apply the reviewed migrations before deploying this server.`);
}
