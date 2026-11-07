-- Billing and learning fixes from the November 7 feature review. Each statement replaces a function with the same signature,
-- so grants are kept. Every change is additive for callers built before it.
--
-- 1. hub.billing_workspace and the Account Manager's account snapshots left deleted coupons out, but Stripe keeps applying a
--    deleted coupon to subscriptions that already have it, so MRR ignored those discounts. Deleted coupons are now included
--    (the workspace flags them as deleted; the Billing screen lists and offers only current coupons).
-- 2. hub.my_billing returned no pricing model, so the tenant billing page guessed it from the product's unit label and showed
--    "1 × $199.00 per facility" for a flat price (and "Customer-entered amount" for a tiered one). It now returns the price's own.
-- 3. hub.import_learning_draft compared a hash of the whole document, placements included, so importing the same export again
--    after an app's course placement changed failed at the first course already imported and stopped the rest. A replay now
--    ignores placements when the imported source is on record.
-- 4. private.learning_import_preservation_error never compared a video's media, so an imported course could publish with a
--    video the import carried swapped for another. A video may still gain media where the import had none.

CREATE OR REPLACE FUNCTION hub.billing_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_live boolean;
begin
  perform hub.authorize_app_admin();
  select livemode into v_live from private.billing_settings;
  return jsonb_build_object(
    'mode',case when v_live is null then 'unverified' when v_live then 'live' else 'test' end,
    'account',(select stripe_account_id from private.billing_settings),
    'apps',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'slug',p.slug,'name',p.name,'status',p.status) order by p.name),'[]'::jsonb)
      from hub.products p where p.status<>'retired' and p.slug not in ('advisors','pennsync')),
    'tenants',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'slug',t.slug,'name',t.name,'industry',coalesce(t.industry,''),'status',t.status,
        'updated_at',t.updated_at,'customer',case when c.tenant_id is null or c.deleted then null else jsonb_build_object('id',c.stripe_customer_id,
          'email',c.email,'name',c.name,'delinquent',c.delinquent,'balance',c.balance,'version',c.version) end) order by t.name,t.id),'[]'::jsonb)
      from hub.tenants t left join private.billing_customers c on c.tenant_id=t.id),
    'subscriptions',(select coalesce(jsonb_agg(private.billing_subscription_view(s) order by s.stripe_created desc),'[]'::jsonb)
      from private.billing_subscriptions s where v_live is null or s.livemode=v_live),
    'products',(select coalesce(jsonb_agg(jsonb_build_object('id',p.stripe_product_id,'app',(select slug from hub.products where id=p.product_id),
        'name',p.name,'description',p.description,'active',p.active,'kind',p.kind,'entitlement_key',p.entitlement_key,'unit_label',p.unit_label,
        'created',p.stripe_created,'version',p.version) order by p.active desc,p.name),'[]'::jsonb)
      from private.billing_products p where v_live is null or p.livemode=v_live),
    'prices',(select coalesce(jsonb_agg(private.billing_price_view(r) order by r.active desc,r.stripe_created desc),'[]'::jsonb)
      from private.billing_prices r where (v_live is null or r.livemode=v_live) and r.tenant_id is null),
    'coupons',(select coalesce(jsonb_agg(jsonb_build_object('id',c.stripe_coupon_id,'name',c.name,'percent_off',c.percent_off,'amount_off',c.amount_off,
        'currency',c.currency,'duration',c.duration,'duration_in_months',c.duration_in_months,'max_redemptions',c.max_redemptions,
        'times_redeemed',c.times_redeemed,'redeem_by',c.redeem_by,'valid',c.valid,'applies_to',to_jsonb(c.applies_to_products),
        'app',(select slug from hub.products where id=c.product_id),'created',c.stripe_created,'version',c.version,'deleted',c.deleted) order by c.stripe_created desc),'[]'::jsonb)
      from private.billing_coupons c where (v_live is null or c.livemode=v_live)),
    'promotion_codes',(select coalesce(jsonb_agg(jsonb_build_object('id',c.stripe_promotion_code_id,'code',c.code,'coupon',c.stripe_coupon_id,
        'active',c.active,'customer',c.stripe_customer_id,'max_redemptions',c.max_redemptions,'times_redeemed',c.times_redeemed,
        'expires_at',c.expires_at,'first_time_transaction',c.first_time_transaction,'minimum_amount',c.minimum_amount,
        'created',c.stripe_created,'version',c.version) order by c.stripe_created desc),'[]'::jsonb)
      from private.billing_promotion_codes c where v_live is null or c.livemode=v_live),
    'app_keys',(select coalesce(jsonb_agg(jsonb_build_object('id',k.id,'app',p.slug,'hint',k.key_hint,'created_at',k.created_at,
        'last_used_at',k.last_used_at,'revoked_at',k.revoked_at) order by k.created_at desc),'[]'::jsonb)
      from private.billing_app_keys k join hub.products p on p.id=k.product_id where p.slug<>'pennsync'),
    'webhook',(select jsonb_build_object('last_received_at',max(received_at),'events_24h',count(*) filter (where received_at>now()-interval '24 hours'))
      from private.billing_webhook_events),
    'loaded_at',now());
end; $function$;

CREATE OR REPLACE FUNCTION private.agent_accounts_json_legacy(p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_live boolean;
  v_total integer;
begin
  select livemode into v_live from private.billing_settings;
  select count(*)::integer into v_total from hub.tenants t
  where exists (select 1 from private.billing_customers c where c.tenant_id = t.id and not c.deleted and (v_live is null or c.livemode = v_live))
     or exists (select 1 from private.billing_subscriptions s where s.tenant_id = t.id and (v_live is null or s.livemode = v_live));
  return jsonb_build_object(
    'generatedAt', now(),
    'mode', case when v_live is null then 'unverified' when v_live then 'live' else 'test' end,
    'total', v_total,
    'truncated', v_total > p_limit,
    'coupons', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.stripe_coupon_id, 'percent_off', c.percent_off, 'amount_off', c.amount_off, 'applies_to', to_jsonb(c.applies_to_products)) order by c.stripe_coupon_id), '[]'::jsonb)
      from private.billing_coupons c where (v_live is null or c.livemode = v_live)),
    'accounts', (select coalesce(jsonb_agg(a.account order by a.name, a.id), '[]'::jsonb) from (
      select t.id, t.name, jsonb_build_object(
        'slug', t.slug, 'name', t.name, 'status', t.status, 'createdAt', t.created_at,
        'products', (select coalesce(jsonb_agg(jsonb_build_object('slug', p.slug, 'planCode', tp.plan_code, 'status', tp.status) order by p.slug), '[]'::jsonb)
          from hub.tenant_products tp join hub.products p on p.id = tp.product_id where tp.tenant_id = t.id and p.status <> 'retired'),
        'customer', (select jsonb_build_object('delinquent', c.delinquent, 'balanceCents', c.balance, 'hasEmail', char_length(btrim(c.email)) > 0)
          from private.billing_customers c where c.tenant_id = t.id and not c.deleted and (v_live is null or c.livemode = v_live)),
        'subscriptions', (select coalesce(jsonb_agg(private.agent_subscription_facts(s) order by s.stripe_created desc), '[]'::jsonb)
          from private.billing_subscriptions s where s.tenant_id = t.id and (v_live is null or s.livemode = v_live)),
        -- An open invoice is overdue three days after its due date, or after it was created when it has none (a card payment Stripe is still retrying).
        'invoices', (select jsonb_build_object(
            'open', count(*) filter (where i.status = 'open'),
            'overdue', count(*) filter (where i.status = 'open' and coalesce(i.due_date, i.stripe_created) < now() - interval '3 days'),
            'remainingCents', coalesce(sum(i.amount_remaining) filter (where i.status = 'open'), 0)::bigint,
            'oldestOverdueDue', min(coalesce(i.due_date, i.stripe_created)) filter (where i.status = 'open' and coalesce(i.due_date, i.stripe_created) < now() - interval '3 days'),
            'latestPaidAt', max(i.stripe_created) filter (where i.status = 'paid'))
          from private.billing_invoices i where i.tenant_id = t.id and (v_live is null or i.livemode = v_live)),
        -- What the applications themselves report: per product and metric, the newest quantity and the newest one at or before 28 days earlier.
        'usage', (select coalesce(jsonb_agg(jsonb_build_object(
            'app', pr.slug, 'metric', u.metric, 'latest', u.quantity, 'latestAt', u.reported_at, 'baseline', b.quantity, 'baselineAt', b.reported_at)
            order by pr.slug, u.metric), '[]'::jsonb)
          from (select distinct on (r.product_id, r.metric) r.tenant_id, r.product_id, r.metric, r.quantity, r.reported_at
                from private.billing_usage_reports r where r.tenant_id = t.id order by r.product_id, r.metric, r.reported_at desc) u
          join hub.products pr on pr.id = u.product_id and pr.status <> 'retired'
          left join lateral (select x.quantity, x.reported_at from private.billing_usage_reports x
                where x.tenant_id = u.tenant_id and x.product_id = u.product_id and x.metric = u.metric and x.reported_at <= now() - interval '28 days'
                order by x.reported_at desc limit 1) b on true),
        -- Numbers only: never a subject, a requester or a message.
        'cases', (select jsonb_build_object(
            'waitingOnYou', count(*) filter (where c.status in ('open', 'in_progress')),
            'highOrUrgent', count(*) filter (where c.status in ('open', 'in_progress') and c.priority in ('high', 'urgent')),
            'waitingOnCustomer', count(*) filter (where c.status = 'waiting_on_customer'),
            'oldestOpenAt', min(c.created_at) filter (where c.status in ('open', 'in_progress')))
          from hub.support_cases c join hub.products cp on cp.id = c.product_id and cp.status <> 'retired' where c.tenant_id = t.id)
      ) as account
      from hub.tenants t
      where exists (select 1 from private.billing_customers c where c.tenant_id = t.id and not c.deleted and (v_live is null or c.livemode = v_live))
         or exists (select 1 from private.billing_subscriptions s where s.tenant_id = t.id and (v_live is null or s.livemode = v_live))
      order by t.name, t.id
      limit p_limit) a));
end;
$function$;

CREATE OR REPLACE FUNCTION private.agent_accounts_page_json(p_limit integer, p_offset integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_live boolean;
  v_total integer;
begin
  select livemode into v_live from private.billing_settings;
  select count(*)::integer into v_total from hub.tenants t
  where exists (select 1 from private.billing_customers c where c.tenant_id = t.id and not c.deleted and (v_live is null or c.livemode = v_live))
     or exists (select 1 from private.billing_subscriptions s where s.tenant_id = t.id and (v_live is null or s.livemode = v_live));
  return jsonb_build_object(
    'generatedAt', now(),
    'mode', case when v_live is null then 'unverified' when v_live then 'live' else 'test' end,
    'total', v_total,
    'truncated', v_total > p_offset + p_limit,
    'coupons', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.stripe_coupon_id, 'percent_off', c.percent_off, 'amount_off', c.amount_off, 'applies_to', to_jsonb(c.applies_to_products)) order by c.stripe_coupon_id), '[]'::jsonb)
      from private.billing_coupons c where (v_live is null or c.livemode = v_live)),
    'accounts', (select coalesce(jsonb_agg(a.account order by a.name, a.id), '[]'::jsonb) from (
      select t.id, t.name, jsonb_build_object(
        'slug', t.slug, 'name', t.name, 'status', t.status, 'createdAt', t.created_at,
        'activity',private.growth_account_activity(t.id),
        'products', (select coalesce(jsonb_agg(jsonb_build_object('slug', p.slug, 'planCode', tp.plan_code, 'status', tp.status) order by p.slug), '[]'::jsonb)
          from hub.tenant_products tp join hub.products p on p.id = tp.product_id where tp.tenant_id = t.id and p.status <> 'retired'),
        'customer', (select jsonb_build_object('delinquent', c.delinquent, 'balanceCents', c.balance, 'hasEmail', char_length(btrim(c.email)) > 0)
          from private.billing_customers c where c.tenant_id = t.id and not c.deleted and (v_live is null or c.livemode = v_live)),
        'subscriptions', (select coalesce(jsonb_agg(private.agent_subscription_facts(s) order by s.stripe_created desc), '[]'::jsonb)
          from private.billing_subscriptions s where s.tenant_id = t.id and (v_live is null or s.livemode = v_live)),
        -- An open invoice is overdue three days after its due date, or after it was created when it has none (a card payment Stripe is still retrying).
        'invoices', (select jsonb_build_object(
            'open', count(*) filter (where i.status = 'open'),
            'overdue', count(*) filter (where i.status = 'open' and coalesce(i.due_date, i.stripe_created) < now() - interval '3 days'),
            'remainingCents', coalesce(sum(i.amount_remaining) filter (where i.status = 'open'), 0)::bigint,
            'oldestOverdueDue', min(coalesce(i.due_date, i.stripe_created)) filter (where i.status = 'open' and coalesce(i.due_date, i.stripe_created) < now() - interval '3 days'),
            'latestPaidAt', max(i.stripe_created) filter (where i.status = 'paid'))
          from private.billing_invoices i where i.tenant_id = t.id and (v_live is null or i.livemode = v_live)),
        -- What the applications themselves report: per product and metric, the newest quantity and the newest one at or before 28 days earlier.
        'usage', (select coalesce(jsonb_agg(jsonb_build_object(
            'app', pr.slug, 'metric', u.metric, 'latest', u.quantity, 'latestAt', u.reported_at, 'baseline', b.quantity, 'baselineAt', b.reported_at)
            order by pr.slug, u.metric), '[]'::jsonb)
          from (select distinct on (r.product_id, r.metric) r.tenant_id, r.product_id, r.metric, r.quantity, r.reported_at
                from private.billing_usage_reports r where r.tenant_id = t.id order by r.product_id, r.metric, r.reported_at desc) u
          join hub.products pr on pr.id = u.product_id and pr.status <> 'retired'
          left join lateral (select x.quantity, x.reported_at from private.billing_usage_reports x
                where x.tenant_id = u.tenant_id and x.product_id = u.product_id and x.metric = u.metric and x.reported_at <= now() - interval '28 days'
                order by x.reported_at desc limit 1) b on true),
        -- Numbers only: never a subject, a requester or a message.
        'cases', (select jsonb_build_object(
            'waitingOnYou', count(*) filter (where c.status in ('open', 'in_progress')),
            'highOrUrgent', count(*) filter (where c.status in ('open', 'in_progress') and c.priority in ('high', 'urgent')),
            'waitingOnCustomer', count(*) filter (where c.status = 'waiting_on_customer'),
            'oldestOpenAt', min(c.created_at) filter (where c.status in ('open', 'in_progress')))
          from hub.support_cases c join hub.products cp on cp.id = c.product_id and cp.status <> 'retired' where c.tenant_id = t.id)
      ) as account
      from hub.tenants t
      where exists (select 1 from private.billing_customers c where c.tenant_id = t.id and not c.deleted and (v_live is null or c.livemode = v_live))
         or exists (select 1 from private.billing_subscriptions s where s.tenant_id = t.id and (v_live is null or s.livemode = v_live))
      order by t.name, t.id
      limit p_limit offset p_offset) a));
end;
$function$;

CREATE OR REPLACE FUNCTION hub.my_billing()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_live boolean;
begin
  if not private.current_app_session_verified() then raise exception 'Sign in with an SMS code to continue.' using errcode='28000'; end if;
  select livemode into v_live from private.billing_settings;
  return jsonb_build_object('tenants',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,
      'has_customer',exists(select 1 from private.billing_customers c where c.tenant_id=t.id and not c.deleted),
      'subscriptions',(select coalesce(jsonb_agg(jsonb_build_object('app',(select name from hub.products where id=s.product_id),'status',s.status,
          'cancel_at_period_end',s.cancel_at_period_end,'current_period_end',s.current_period_end,'trial_end',s.trial_end,
          'paused',s.pause_behavior is not null,'items',(select coalesce(jsonb_agg(jsonb_build_object('name',coalesce(p.name,'Plan'),'kind',coalesce(p.kind,'plan'),
            'quantity',i.quantity,'unit_label',coalesce(p.unit_label,''),'unit_amount',i.unit_amount,'currency',i.currency,'interval',i.recurring_interval,
            'interval_count',i.interval_count,'pricing_model',(select r.pricing_model from private.billing_prices r where r.stripe_price_id=i.stripe_price_id)) order by p.kind,p.name),'[]'::jsonb)
            from private.billing_subscription_items i left join private.billing_products p on p.stripe_product_id=i.stripe_product_id
            where i.stripe_subscription_id=s.stripe_subscription_id)) order by s.stripe_created desc),'[]'::jsonb)
        from private.billing_subscriptions s where s.tenant_id=t.id and (v_live is null or s.livemode=v_live)
          and s.status not in ('incomplete_expired') and (s.status<>'canceled' or s.ended_at>now()-interval '90 days')),
      'invoices',(select coalesce(jsonb_agg(jsonb_build_object('id',v.stripe_invoice_id,'number',v.number,'status',v.status,'currency',v.currency,
          'total',v.total,'amount_remaining',v.amount_remaining,'due_date',v.due_date,'created',v.stripe_created,
          'hosted_invoice_url',v.hosted_invoice_url,'invoice_pdf',v.invoice_pdf) order by v.stripe_created desc),'[]'::jsonb)
        from (select * from private.billing_invoices where tenant_id=t.id and status<>'draft' and (v_live is null or livemode=v_live)
          order by stripe_created desc limit 50) v)
    ) order by t.name),'[]'::jsonb)
    from hub.tenants t where exists(select 1 from hub.tenant_product_memberships m where m.tenant_id=t.id and m.user_id=(select auth.uid())
      and m.role='tenant_admin' and m.status='active' and m.revoked_at is null and private.hub_application_enabled(m.product_id) and exists(select 1 from hub.products p where p.id=m.product_id and p.slug<>'pennsync'))),
    'loaded_at',now());
end; $function$;

CREATE OR REPLACE FUNCTION hub.import_learning_draft(p_source_course_id uuid, p_source_version_id uuid, p_document jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare editor uuid; v_item_id uuid; v_hash text; prior private.learning_imports%rowtype;
begin
  editor:=private.require_learning_editor();
  if p_source_course_id is null or p_source_version_id is null then
    raise exception 'Source course and revision are required.' using errcode='22023';
  end if;
  perform private.validate_learning_document(p_document);
  select l.content_item_id into v_item_id from hub.course_links l
    join hub.content_items i on i.id=l.content_item_id
    where l.penntrain_course_id=p_source_course_id::text and i.kind='course'
    for update of i;
  if not found then raise exception 'Source course is not registered in the central catalog.' using errcode='22023'; end if;
  v_hash:=encode(extensions.digest(p_document::text,'sha256'),'hex');
  select * into prior from private.learning_imports where source_course_id=p_source_course_id;
  if found then
    -- The same export imported again is a replay even when the apps it is placed on differ (an app retired or reopened for courses
    -- since): placements are reviewed in the editor. Older imports that kept no source document still compare the whole hash.
    if prior.source_version_id<>p_source_version_id or (prior.document_sha256<>v_hash
      and (prior.source_document is null or (prior.source_document - 'productIds') is distinct from (p_document - 'productIds'))) then
      raise exception 'This course was already imported. Review revisions in the course editor.' using errcode='40001';
    end if;
    if prior.source_document is null then
      update private.learning_imports set source_document=p_document where source_course_id=p_source_course_id;
    end if;
    return hub.get_learning_draft(prior.item_id);
  end if;
  insert into private.learning_courses(item_id,draft,updated_by) values(v_item_id,p_document,editor);
  insert into private.learning_imports(source_course_id,source_version_id,document_sha256,item_id,source_document)
    values(p_source_course_id,p_source_version_id,v_hash,v_item_id,p_document);
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(editor,'learning.course.imported','content_item',v_item_id,jsonb_build_object('source_version_id',p_source_version_id));
  return hub.get_learning_draft(v_item_id);
end;
$function$;

CREATE OR REPLACE FUNCTION private.learning_import_preservation_error(p_item_id uuid, p_draft jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  import_row private.learning_imports%rowtype;
  source_doc jsonb; source_unit jsonb; draft_unit jsonb; source_question jsonb; draft_question jsonb;
  unit_position integer; question_position integer;
begin
  select * into import_row from private.learning_imports where item_id = p_item_id;
  if not found or import_row.source_document is null then return 'source'; end if;
  source_doc := import_row.source_document;
  -- Credit is the imported duration; the Hub reports it on every certificate.
  if p_draft->'durationMinutes' is distinct from source_doc->'durationMinutes' then return 'credit'; end if;
  if jsonb_array_length(p_draft->'units') <> jsonb_array_length(source_doc->'units') then return 'lessons'; end if;
  for unit_position in 0 .. jsonb_array_length(source_doc->'units') - 1 loop
    source_unit := source_doc->'units'->unit_position;
    draft_unit := p_draft->'units'->unit_position;
    if draft_unit->>'id' is distinct from source_unit->>'id'
      or draft_unit->>'type' is distinct from source_unit->>'type'
      or draft_unit->>'title' is distinct from source_unit->>'title'
      or coalesce(draft_unit->>'body', '') is distinct from coalesce(source_unit->>'body', '')
      -- A video may gain central media where the import had none; media the import carried stays the same.
      or (source_unit->>'mediaAssetId' is not null and draft_unit->>'mediaAssetId' is distinct from source_unit->>'mediaAssetId') then
      return 'lessons';
    end if;
    if source_unit->>'type' = 'quiz' then
      if draft_unit->'passingScore' is distinct from source_unit->'passingScore'
        or draft_unit->'maxAttempts' is distinct from source_unit->'maxAttempts'
        or jsonb_array_length(draft_unit->'questions') <> jsonb_array_length(source_unit->'questions') then
        return 'quiz';
      end if;
      for question_position in 0 .. jsonb_array_length(source_unit->'questions') - 1 loop
        source_question := source_unit->'questions'->question_position;
        draft_question := draft_unit->'questions'->question_position;
        if draft_question->>'id' is distinct from source_question->>'id'
          or draft_question->>'prompt' is distinct from source_question->>'prompt'
          or draft_question->'points' is distinct from source_question->'points'
          or draft_question->>'correctOptionId' is distinct from source_question->>'correctOptionId'
          or draft_question->'correctOptionIds' is distinct from source_question->'correctOptionIds'
          or draft_question->'options' is distinct from source_question->'options' then
          return 'quiz';
        end if;
      end loop;
    end if;
  end loop;
  return null;
end;
$function$;
