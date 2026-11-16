-- Declares learning.lesson-media.direct-storage.v1 once the app-media function signs one-time upload addresses (its upload-sign
-- operation, docs/CENTRAL_LEARNING.md). While it is declared, the Hub sends lesson videos, captions and transcripts (the library's
-- upload and the bulk media import) straight to the private hub-learning bucket through such an address, never overwriting an object,
-- and reads each one back on a ten-minute signed address to check it, instead of streaming them through app-media, whose 150-second
-- response limit a 256 MB video over a slow link to Storage could outlast. An upload address is authorized exactly as an upload
-- (hub.authorize_learning_object with 'upload'), and neither address leaves the server. Declaring it grants nothing; deploy app-media
-- with upload-sign before applying this. Until it is declared, the Hub streams lesson media through app-media as before.
do $$ declare contract jsonb:=hub.get_backend_contract(); begin
  if (contract @> '{"api_version":4,"features":["learning.runtime.v1"]}'::jsonb) is not true
    or to_regprocedure('hub.authorize_learning_object(text,text)') is null then
    raise exception 'Apply the central learning runtime first' using errcode='55000';
  end if;
  if not (contract->'features' @> '["learning.lesson-media.direct-storage.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["learning.lesson-media.direct-storage.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
