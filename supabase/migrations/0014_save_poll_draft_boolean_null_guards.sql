-- Defense-in-depth, server-side companion to the frontend fix for the
-- "anonymous null propagation" bug (index.html buildSettings(): a JS
-- expression like `anonForced || (secretCk && secretCk.checked)` evaluates
-- to `null`, not `false`, whenever secretCk is null -- which then flowed
-- straight through to save_poll_draft's p_anonymous parameter and was
-- correctly rejected by polls.anonymous's NOT NULL constraint).
--
-- The frontend fix (wrapping in !!(...)) addresses the root cause. This
-- migration adds an explicit, loud rejection at the RPC boundary for every
-- boolean parameter save_poll_draft accepts, so that ANY future caller --
-- this frontend after a regression, a different client, a direct API
-- call -- gets a clear, specific error message instead of an opaque
-- Postgres "null value in column ... violates not-null constraint" error
-- (or, if the target column were ever changed to be nullable down the
-- line, instead of silently persisting a null).
--
-- Deliberately NOT a silent default/COALESCE: coalescing a null
-- p_anonymous to false, for example, would be a serious privacy bug for
-- elections/secret ballots if a client ever sent null where it meant
-- true. Failing loudly and specifically is the safe behavior here, and
-- the existing NOT NULL constraint on polls.anonymous is left exactly as
-- strict as it already was.
--
-- Redefined identically to migration 0011 except for the added guards
-- immediately after the existing authorization/title/questions/close-date
-- checks.
-- ============================================================
create or replace function save_poll_draft(
  p_poll_id uuid,
  p_org_id uuid,
  p_title text,
  p_description text,
  p_poll_type text,
  p_access_mode text,
  p_anonymous boolean,
  p_allow_change_vote boolean,
  p_results_visibility text,
  p_show_respondent_identities boolean,
  p_timezone text,
  p_open_at timestamptz,
  p_close_at timestamptz,
  p_questions jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll_id uuid;
  v_existing record;
  v_q jsonb;
  v_qi int := 0;
  v_new_q_id uuid;
  v_o jsonb;
  v_oi int;
  v_opt_count int;
  v_has_write_in boolean;
  v_has_abstain boolean;
begin
  if not is_org_admin(auth.uid(), p_org_id) then
    raise exception 'not_authorized';
  end if;
  if coalesce(trim(p_title), '') = '' then
    raise exception 'title_required';
  end if;
  if jsonb_typeof(p_questions) is distinct from 'array' or jsonb_array_length(p_questions) < 1 then
    raise exception 'at_least_one_question_required';
  end if;
  if p_poll_type = 'election' and p_close_at is null then
    raise exception 'elections_require_a_close_date';
  end if;

  -- Explicit boolean-null guards (defense-in-depth -- see migration header).
  if p_anonymous is null then
    raise exception 'anonymous_flag_must_be_true_or_false_not_null';
  end if;
  if p_allow_change_vote is null then
    raise exception 'allow_change_vote_flag_must_be_true_or_false_not_null';
  end if;
  if p_show_respondent_identities is null then
    raise exception 'show_respondent_identities_flag_must_be_true_or_false_not_null';
  end if;

  if p_poll_id is not null then
    select * into v_existing from polls where id = p_poll_id;
    if not found then raise exception 'poll_not_found'; end if;
    if v_existing.org_id <> p_org_id then raise exception 'org_mismatch'; end if;
    if v_existing.status <> 'draft' then raise exception 'poll_not_draft_editable'; end if;
    if not is_org_admin(auth.uid(), v_existing.org_id) then raise exception 'not_authorized'; end if;

    update polls set
      title = p_title, description = coalesce(p_description, ''),
      poll_type = p_poll_type, access_mode = p_access_mode, anonymous = p_anonymous,
      allow_change_vote = p_allow_change_vote, results_visibility = p_results_visibility,
      show_respondent_identities = p_show_respondent_identities, timezone = coalesce(p_timezone, timezone),
      open_at = p_open_at, close_at = p_close_at, updated_at = now()
    where id = p_poll_id;

    delete from questions where poll_id = p_poll_id; -- cascades to options
    v_poll_id := p_poll_id;
  else
    insert into polls (org_id, title, description, poll_type, access_mode, anonymous,
                        allow_change_vote, results_visibility, show_respondent_identities,
                        timezone, open_at, close_at, status, created_by)
    values (p_org_id, p_title, coalesce(p_description, ''), p_poll_type, p_access_mode, p_anonymous,
            p_allow_change_vote, p_results_visibility, p_show_respondent_identities,
            coalesce(p_timezone, 'America/Chicago'), p_open_at, p_close_at, 'draft', auth.uid())
    returning id into v_poll_id;
  end if;

  for v_q in select * from jsonb_array_elements(p_questions)
  loop
    if (v_q->>'question_type') not in ('single_select','multi_select','yesno','rating','text','availability') then
      raise exception 'invalid_question_type';
    end if;

    insert into questions (poll_id, order_index, prompt, question_type, max_selections,
                            allow_write_in, allow_abstain, required, rating_min, rating_max)
    values (
      v_poll_id, v_qi,
      coalesce(nullif(trim(v_q->>'prompt'), ''), p_title),
      v_q->>'question_type',
      nullif(v_q->>'max_selections','')::int,
      coalesce((v_q->>'allow_write_in')::boolean, false),
      coalesce((v_q->>'allow_abstain')::boolean, false),
      coalesce((v_q->>'required')::boolean, true),
      case when v_q->>'question_type' = 'rating' then coalesce(nullif(v_q->>'rating_min','')::int, 1) end,
      case when v_q->>'question_type' = 'rating' then coalesce(nullif(v_q->>'rating_max','')::int, 5) end
    )
    returning id into v_new_q_id;
    v_qi := v_qi + 1;

    if v_q->>'question_type' = 'yesno' then
      insert into options (question_id, order_index, label) values (v_new_q_id, 0, 'Yes');
      insert into options (question_id, order_index, label) values (v_new_q_id, 1, 'No');

    elsif v_q->>'question_type' = 'availability' then
      v_oi := 0;
      for v_o in select * from jsonb_array_elements(coalesce(v_q->'options', '[]'::jsonb))
      loop
        if v_o->>'slot_start' is null or v_o->>'slot_start' = '' then continue; end if;
        insert into options (question_id, order_index, label, slot_start, slot_end)
        values (v_new_q_id, v_oi,
                coalesce(nullif(v_o->>'label',''),
                         to_char((v_o->>'slot_start')::timestamptz at time zone coalesce(p_timezone, 'UTC'), 'Dy Mon DD, HH12:MI AM')),
                (v_o->>'slot_start')::timestamptz, nullif(v_o->>'slot_end','')::timestamptz);
        v_oi := v_oi + 1;
      end loop;
      if v_oi < 1 then raise exception 'availability_needs_at_least_one_slot'; end if;

    elsif v_q->>'question_type' in ('single_select', 'multi_select') then
      v_oi := 0;
      v_opt_count := 0;
      v_has_write_in := coalesce((v_q->>'allow_write_in')::boolean, false);
      v_has_abstain := coalesce((v_q->>'allow_abstain')::boolean, false);
      for v_o in select * from jsonb_array_elements(coalesce(v_q->'options', '[]'::jsonb))
      loop
        if coalesce(trim(v_o->>'label'), '') = '' then continue; end if;
        insert into options (question_id, order_index, label) values (v_new_q_id, v_oi, trim(v_o->>'label'));
        v_oi := v_oi + 1;
        v_opt_count := v_opt_count + 1;
      end loop;
      if v_opt_count < 2 then raise exception 'choice_question_needs_two_options'; end if;
      if v_has_abstain then
        insert into options (question_id, order_index, label, is_abstain) values (v_new_q_id, v_oi, 'Abstain', true);
        v_oi := v_oi + 1;
      end if;
      if v_has_write_in then
        insert into options (question_id, order_index, label, is_write_in) values (v_new_q_id, v_oi, 'Write-in', true);
        v_oi := v_oi + 1;
      end if;
    end if;
    -- 'rating' and 'text' question types need no option rows.
  end loop;

  perform log_audit(p_org_id, v_poll_id, case when p_poll_id is null then 'poll_created' else 'poll_draft_updated' end, '{}'::jsonb);
  return v_poll_id;
end;
$$;

revoke execute on function save_poll_draft(uuid, uuid, text, text, text, text, boolean, boolean, text, boolean, text, timestamptz, timestamptz, jsonb) from public;
grant execute on function save_poll_draft(uuid, uuid, text, text, text, text, boolean, boolean, text, boolean, text, timestamptz, timestamptz, jsonb) to authenticated;
