update hub.support_contacts
set
  value = 'https://support-hub-web-production.up.railway.app',
  label = 'Central support portal',
  is_active = true,
  verified_at = now(),
  updated_at = now()
where product_id is null
  and tenant_id is null
  and channel = 'web';
