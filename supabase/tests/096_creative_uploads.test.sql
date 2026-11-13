begin;
select plan(16);

select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.creative-uploads.v1', 'Owner video uploads are declared');
select ok(has_function_privilege('authenticated', 'hub.add_creative_video(text,text[],text,bytea,numeric,integer,integer,boolean,uuid)', 'execute')
  and not has_function_privilege('anon', 'hub.add_creative_video(text,text[],text,bytea,numeric,integer,integer,boolean,uuid)', 'execute'),
  'Only a signed-in session may upload, and the operation authorizes the owner itself');
select ok(not has_function_privilege('hub_app_server', 'private.creative_video_store(uuid,text,text[],text,bytea,numeric,integer,integer,boolean,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.creative_video_store(uuid,text,text[],text,bytea,numeric,integer,integer,boolean,uuid)', 'execute'),
  'No role may store an upload directly');

-- A forged session is refused before anything is read.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated","sms_session_id":"00000000-0000-4000-8000-0000000000ab"}';
select throws_ok($$select hub.add_creative_video('caremetric-intel', array['meta.video_vertical'], 'Intro', '\x0000001866747970'::bytea, 30, 1080, 1920, true,
  '00000000-0000-4000-8000-0000000000ac')$$, '28000', null, 'A forged session cannot upload');
reset request.jwt.claims;

insert into auth.users(id, email, is_anonymous) values ('00000000-0000-4000-8000-0000000000ad', 'upload-owner@test.invalid', false);
-- An MP4 begins with its size and "ftyp"; the rest of this fixture is padding.
create temporary table fixture as select '\x0000001866747970'::bytea || decode(repeat('00', 2048), 'hex') as mp4;

select is((select jsonb_array_length(private.creative_video_store('00000000-0000-4000-8000-0000000000ad', 'caremetric-intel',
    array['meta.video_vertical', 'linkedin.video_vertical'], '30-second commercial', mp4, 30, 1080, 1920, true, '00000000-0000-4000-8000-0000000000ae') -> 'assets')
  from fixture), 2, 'A vertical video becomes approved creative for Meta and LinkedIn');
select is((select count(*)::integer from private.creative_assets where provider = 'owner' and status = 'approved' and public_token ~ '^[0-9a-f]{64}$'
  and kind = 'video' and content_type = 'video/mp4' and compliance ->> 'verdict' = 'pass'), 2, 'Each is approved with its own public token');
select is((select count(*)::integer from private.creative_files f join private.creative_assets a on a.id = f.asset_id
  where a.provider = 'owner' and f.phi_free_attested and f.content_type = 'video/mp4'), 2, 'Each keeps the file with the owner''s attestation');
select is((select source || ':' || status from private.creative_briefs where request_key = 'upload:00000000-0000-4000-8000-0000000000ae'), 'upload:done',
  'The upload is one finished brief');
select is((select private.creative_video_store('00000000-0000-4000-8000-0000000000ad', 'caremetric-intel', array['meta.video_vertical'], 'Again', mp4, 30,
    1080, 1920, true, '00000000-0000-4000-8000-0000000000ae') ->> 'already' from fixture), 'true', 'The same upload sent twice is stored once');
select is((select count(*)::integer from private.creative_assets where provider = 'owner'), 2, 'Nothing more was stored');
select ok(exists (select 1 from private.audit_events where action = 'creative.video_upload'), 'The upload is audited');

select throws_ok($$select private.creative_video_store('00000000-0000-4000-8000-0000000000ad', 'caremetric-intel', array['meta.video_landscape'], 'Wide',
  mp4, 30, 1080, 1920, true, gen_random_uuid()) from fixture$$, '22023', 'The video does not fit meta.video_landscape.', 'A video must fit each placement');
select throws_ok($$select private.creative_video_store('00000000-0000-4000-8000-0000000000ad', 'caremetric-intel', array['meta.video_vertical'], 'Long',
  mp4, 93, 1080, 1920, true, gen_random_uuid()) from fixture$$, '22023', 'The video does not fit meta.video_vertical.', 'Meta Reels take at most a minute');
select throws_ok($$select private.creative_video_store('00000000-0000-4000-8000-0000000000ad', 'caremetric-intel', array['linkedin.video_square', 'linkedin.video_vertical'],
  'Two', mp4, 30, 1080, 1080, true, gen_random_uuid()) from fixture$$, '22023', null, 'An upload names at most one placement per platform');
select throws_ok($$select private.creative_video_store('00000000-0000-4000-8000-0000000000ad', 'caremetric-intel', array['linkedin.video_landscape'], 'Unattested',
  mp4, 30, 1920, 1080, false, gen_random_uuid()) from fixture$$, '22023', 'Confirm that the video shows no patient, resident or personal information.',
  'The owner must attest that it shows no personal information');
select throws_ok($$select private.creative_video_store('00000000-0000-4000-8000-0000000000ad', 'caremetric-intel', array['linkedin.video_landscape'], 'Not a video',
  decode(repeat('00', 2048), 'hex'), 30, 1920, 1080, true, gen_random_uuid())$$, '22023', 'The video must be an MP4 file of at most 60 MB.', 'Only an MP4 file is stored');

select * from finish();
rollback;
