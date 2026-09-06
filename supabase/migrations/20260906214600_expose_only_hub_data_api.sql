-- Expose only the reviewed application schema through PostgREST.
alter role authenticator set pgrst.db_schemas = 'hub';
notify pgrst, 'reload config';

