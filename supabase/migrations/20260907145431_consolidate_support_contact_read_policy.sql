drop policy if exists support_contacts_public_read on hub.support_contacts;
drop policy if exists support_contacts_staff_read on hub.support_contacts;
drop policy if exists support_contacts_authenticated_read on hub.support_contacts;

create policy support_contacts_public_read
on hub.support_contacts
for select
to anon
using (is_active and verified_at is not null and tenant_id is null);

create policy support_contacts_authenticated_read
on hub.support_contacts
for select
to authenticated
using (
  (is_active and verified_at is not null and tenant_id is null)
  or private.has_staff_permission('tenant.manage', product_id)
);
