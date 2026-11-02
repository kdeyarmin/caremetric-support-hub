import { HttpError, withSession } from './sms-auth.mjs';

// This is a closed application API, never a general SQL or PostgREST proxy.
export const rpcArguments = Object.freeze({
  get_support_actor_context: [], list_published_content: [], get_backend_contract: [],
  get_support_readiness: [],
  get_ai_usage_summary: ['p_days'],
  get_agent_team: [],
  list_agent_activity: ['p_kind','p_agent_key','p_offset','p_limit'],
  list_audit_events: ['p_action_prefix','p_offset','p_limit'],
  list_phone_numbers: [],
  save_phone_number: ['p_id','p_record','p_expected_version'],
  billing_workspace: [], billing_customer: ['p_tenant_id'], my_billing: [],
  self_service_workspace: [],
  create_tenant: ['p_record'],
  save_tenant: ['p_tenant_id','p_record','p_expected_updated_at'],
  list_support_intake_tenants: ['p_product_id','p_offset','p_limit'],
  set_support_intake: ['p_tenant_id','p_product_id','p_enabled','p_reviewed','p_expected_updated_at'],
  get_support_case_thread: ['p_case_id'],
  create_support_case: ['p_tenant_id','p_product_id','p_subject','p_category','p_priority','p_body','p_app_version','p_route','p_contains_phi','p_request_key'],
  create_facility_support_case: ['p_tenant_id','p_product_id','p_subject','p_category','p_priority','p_body','p_app_version','p_route','p_contains_phi','p_request_key','p_facility_id','p_shared'],
  reply_to_support_case: ['p_case_id','p_body','p_visibility','p_request_key'],
  record_ai_resolution_response: ['p_case_id','p_fixed','p_request_key'],
  request_human_support: ['p_case_id','p_request_key'],
  update_support_case: ['p_case_id','p_status','p_priority','p_assigned_to','p_change_assignment'],
  get_learning_editor_access: [], list_learning_drafts: [], list_learning_media: [], list_learning_catalog: [], list_my_learning: [],
  get_learning_draft: ['p_item_id'],
  list_learning_source_heads: [], get_learning_source_snapshot: ['p_snapshot_id'],
  stage_learning_source: ['p_payload','p_source_revision','p_expected_revision'],
  save_learning_draft: ['p_item_id','p_document','p_expected_version'],
  publish_learning_course: ['p_item_id','p_expected_version','p_reviewed'],
  import_learning_draft: ['p_source_course_id','p_source_version_id','p_document'],
  get_learning_course: ['p_item_id','p_enrollment_id'], enroll_learning_course: ['p_item_id'],
  submit_learning_unit: ['p_enrollment_id','p_unit_id','p_answers','p_attested','p_request_key'],
  get_learning_certificate: ['p_enrollment_id'],
  register_learning_media: ['p_id','p_title','p_sha256','p_reviewed'],
  get_learning_media_paths: ['p_asset_id','p_enrollment_id'], authorize_app_admin: [],
});
const publicCalls = new Set(['list_published_content','get_backend_contract','list_learning_catalog','get_learning_editor_access']);
const reads = Object.freeze({
  products: 'select * from hub.products order by name',
  support_contacts: 'select * from hub.support_contacts order by priority_order',
  support_case_queue: 'select * from hub.support_case_queue order by last_message_at desc',
});
const jsonFields = new Set(['p_document','p_answers','p_record']);
const rowSets = new Set(['list_published_content','get_support_case_thread']);

export function rpcQuery(name, args = {}) {
  const allowed = rpcArguments[name];
  if (!Object.hasOwn(rpcArguments, name) || !allowed || !args || typeof args !== 'object' || Array.isArray(args)) throw new HttpError(400, 'Unsupported request.');
  const keys = Object.keys(args);
  if (keys.some(key => !allowed.includes(key))) throw new HttpError(400, 'Unsupported request parameters.');
  const values = keys.map(key => jsonFields.has(key) ? JSON.stringify(args[key]) : args[key]);
  const parameters = keys.map((key,index) => `${key} => $${index+1}${jsonFields.has(key) ? '::jsonb' : ''}`);
  const call = `hub.${name}(${parameters.join(',')})`;
  return { text: rowSets.has(name) ? `select coalesce(jsonb_agg(to_jsonb(result)), '[]'::jsonb) as data from ${call} result` : `select to_jsonb(${call}) as data`, values };
}

export function gateway(pool) {
  return {
    rpc: (name,args,sessionToken) => {
      const query = rpcQuery(name,args);
      return withSession(pool,sessionToken,async db => (await db.query(query)).rows[0].data,!publicCalls.has(name)).catch(error => {
        if (name === 'create_facility_support_case' && error?.code === '22023') throw new HttpError(400, 'The facility or privacy selection changed. Review a new support request.');
        throw error;
      });
    },
    rows: (name,sessionToken) => {
      if (!Object.hasOwn(reads,name)) throw new HttpError(404,'This resource is unavailable.');
      return withSession(pool,sessionToken,async db => (await db.query(reads[name])).rows,name==='support_case_queue');
    },
    session: sessionToken => withSession(pool,sessionToken,async (db,session) => {
      if (!session) return { authenticated:false };
      // The actor RPC rechecks Auth-user usability and current relational permissions.
      const actor = (await db.query('select hub.get_support_actor_context() as actor')).rows[0].actor;
      return { authenticated:true, userId:actor.id, method:'sms' };
    },false),
  };
}
