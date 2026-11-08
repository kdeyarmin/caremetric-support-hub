-- Keep existing usernames valid while allowing a normalized email as the
-- owner's login identifier. Credential storage, permissions and sessions are
-- unchanged; no owner credentials are created or reset by this migration.
alter table private.password_credentials
  drop constraint password_credentials_username_check,
  add constraint password_credentials_username_check check (
    username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    or (
      length(username) <= 254
      and length(split_part(username, '@', 1)) <= 64
      and username ~ $email$^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$$email$
    )
  );
