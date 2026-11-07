-- Two additive changes to Hub-authored courses.
--
-- 1. Select-all-that-apply questions. A quiz question names either one correct option
--    (correctOptionId, unchanged) or a set of correct options (correctOptionIds). A learner
--    answers a select-all question with the set of options they chose, and earns its points
--    only for exactly the correct set, as CareMetric PennSync's native grader does
--    (base44/functions/gradeTrainingAttempt). The learner document marks the question as
--    multiple and never includes either key.
-- 2. CareMetric PennSync as a course placement. 20261028220500 retired PennSync with every
--    other app outside CareBase, Breathe and Intel. Courses may be placed on it again. The
--    product stays retired for everything else: support intake, billing keys, native
--    connections and self-service remain closed (private.hub_application_enabled still names
--    only CareBase, Breathe and Intel). Its registry name becomes CareMetric PennSync.
--
-- The functions are patched in place from their installed definitions, so unrelated rules are
-- kept exactly. Each anchor must match once or the migration fails without changing anything.
set local lock_timeout = '10s';

do $patch$
declare
  definition text;
  anchor text;
  function_name text;

  -- private.validate_learning_document(jsonb, boolean)
  validate_declare constant text := 'last_quiz bigint; last_lesson bigint;';
  validate_product constant text := 'select 1 from hub.products p where p.id = product_id and p.status <> ''retired''';
  validate_key constant text := $old$        if not coalesce((question->>'correctOptionId')::uuid = any(option_ids), false) then
          raise exception 'Choose exactly one valid correct answer.' using errcode = '22023';
        end if;$old$;

  -- hub.submit_learning_unit(uuid, uuid, jsonb, boolean, uuid)
  submit_grading constant text := $old$    for question in select value from jsonb_array_elements(unit->'questions') loop
      if jsonb_typeof(p_answers->(question->>'id')) is distinct from 'string'
        or not exists(select 1 from jsonb_array_elements(question->'options') o
          where o->>'id'=p_answers->>(question->>'id')) then
        raise exception 'Quiz answer is not a valid option.' using errcode='22023';
      end if;
      question_points := coalesce((question->>'points')::integer,1);
      total_points := total_points + question_points;
      if p_answers->>(question->>'id')=question->>'correctOptionId' then correct:=correct+question_points; end if;
    end loop;$old$;

  -- private.learning_public_document(jsonb)
  public_points constant text := $old$'points', coalesce((q.value->>'points')::integer,1),$old$;
begin
  -- Validation: the select-all key and the PennSync placement.
  definition := pg_get_functiondef('private.validate_learning_document(jsonb,boolean)'::regprocedure);
  foreach anchor in array array[validate_declare, validate_product, validate_key] loop
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Review private.validate_learning_document before patching: %', left(anchor, 60) using errcode = '55000';
    end if;
  end loop;
  definition := replace(definition, validate_declare, validate_declare || ' correct_key jsonb; correct_ids uuid[];');
  definition := replace(definition, validate_product,
    'select 1 from hub.products p where p.id = product_id and (p.status <> ''retired'' or p.slug = ''pennsync'')');
  definition := replace(definition, validate_key, $new$        if question ? 'correctOptionIds' then
          -- Select all that apply: one or more distinct listed options, and no single-answer key.
          if question ? 'correctOptionId' or jsonb_typeof(question->'correctOptionIds') is distinct from 'array'
            or jsonb_array_length(question->'correctOptionIds') not between 1 and jsonb_array_length(question->'options') then
            raise exception 'Choose one or more valid correct answers.' using errcode = '22023';
          end if;
          correct_ids := '{}';
          for correct_key in select value from jsonb_array_elements(question->'correctOptionIds') loop
            if jsonb_typeof(correct_key) is distinct from 'string'
              or (correct_key#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
              raise exception 'Choose one or more valid correct answers.' using errcode = '22023';
            end if;
            if not ((correct_key#>>'{}')::uuid = any(option_ids)) or (correct_key#>>'{}')::uuid = any(correct_ids) then
              raise exception 'Choose one or more valid correct answers.' using errcode = '22023';
            end if;
            correct_ids := array_append(correct_ids, (correct_key#>>'{}')::uuid);
          end loop;
        elsif not coalesce((question->>'correctOptionId')::uuid = any(option_ids), false) then
          raise exception 'Choose exactly one valid correct answer.' using errcode = '22023';
        end if;$new$);
  execute definition;

  -- Grading: a select-all answer is the set of chosen options; credit only for the exact set.
  definition := pg_get_functiondef('hub.submit_learning_unit(uuid,uuid,jsonb,boolean,uuid)'::regprocedure);
  if (length(definition) - length(replace(definition, submit_grading, ''))) / length(submit_grading) <> 1 then
    raise exception 'Review hub.submit_learning_unit before patching' using errcode = '55000';
  end if;
  execute replace(definition, submit_grading, $new$    for question in select value from jsonb_array_elements(unit->'questions') loop
      question_points := coalesce((question->>'points')::integer,1);
      total_points := total_points + question_points;
      if question ? 'correctOptionIds' then
        -- Select all that apply: a non-empty set of distinct listed options.
        if jsonb_typeof(p_answers->(question->>'id')) is distinct from 'array'
          or jsonb_array_length(p_answers->(question->>'id')) = 0
          or exists(select 1 from jsonb_array_elements(p_answers->(question->>'id')) a
            where jsonb_typeof(a) is distinct from 'string'
              or not exists(select 1 from jsonb_array_elements(question->'options') o where o->>'id' = a#>>'{}'))
          or (select count(distinct a#>>'{}') from jsonb_array_elements(p_answers->(question->>'id')) a)
            <> jsonb_array_length(p_answers->(question->>'id')) then
          raise exception 'Quiz answer is not a valid option.' using errcode='22023';
        end if;
        if (select array_agg(distinct (a#>>'{}')::uuid order by (a#>>'{}')::uuid) from jsonb_array_elements(p_answers->(question->>'id')) a)
          = (select array_agg(distinct (k#>>'{}')::uuid order by (k#>>'{}')::uuid) from jsonb_array_elements(question->'correctOptionIds') k) then
          correct:=correct+question_points;
        end if;
      else
        if jsonb_typeof(p_answers->(question->>'id')) is distinct from 'string'
          or not exists(select 1 from jsonb_array_elements(question->'options') o
            where o->>'id'=p_answers->>(question->>'id')) then
          raise exception 'Quiz answer is not a valid option.' using errcode='22023';
        end if;
        if p_answers->>(question->>'id')=question->>'correctOptionId' then correct:=correct+question_points; end if;
      end if;
    end loop;$new$);

  -- Learner document: say whether a question takes several answers, never which ones.
  definition := pg_get_functiondef('private.learning_public_document(jsonb)'::regprocedure);
  if (length(definition) - length(replace(definition, public_points, ''))) / length(public_points) <> 1 then
    raise exception 'Review private.learning_public_document before patching' using errcode = '55000';
  end if;
  execute replace(definition, public_points, public_points || ' ''multiple'', q.value ? ''correctOptionIds'',');
end;
$patch$;

-- Courses only: the product stays retired, unsupported and disconnected everywhere else.
update hub.products set name = 'CareMetric PennSync', updated_at = now() where slug = 'pennsync';
