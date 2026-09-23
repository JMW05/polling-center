-- CRITICAL FIX. Live inspection (information_schema.role_table_grants,
-- confirmed by an actual `set role authenticated; select from polls`
-- probe returning "permission denied") showed that migration 0002's
-- blanket `revoke all ... from anon, authenticated` was never followed
-- by a re-grant for ANY table except `organizations`. Every `_admin_read`
-- RLS policy written for polls/questions/options/identified_responses/
-- identified_answers/voter_eligibility/audit_log/org_admins was therefore
-- completely inert — Postgres checks the base GRANT before it ever
-- consults RLS, so admins could not read any of that data at all, not
-- just poll creation. Separately, the frontend's saveAll() wrote to
-- polls/questions/options directly, which was ALSO failing outright, and
-- for a different reason (no grant of any kind, not even a permissive
-- one). Both things were true at once — the frontend attempted writes
-- the database would refuse, while a status report describing the
-- intended "no direct writes" design was accurate about the goal but
-- not about what was actually wired up.
--
-- Fix, matching the stronger design requested: grant SELECT only (never
-- INSERT/UPDATE/DELETE) to authenticated on the tables that already have
-- a correct admin-scoped RLS read policy, so those policies finally take
-- effect. All writes to polls/questions/options now go through
-- save_poll_draft() below — a single SECURITY DEFINER transaction that
-- validates authorization and integrity server-side and replaces the
-- old direct insert/update/delete calls entirely.

grant select on polls to authenticated;
grant select on questions to authenticated;
grant select on options to authenticated;
grant select on identified_responses to authenticated;
grant select on identified_answers to authenticated;
grant select on voter_eligibility to authenticated;
grant select on audit_log to authenticated;
grant select on org_admins to authenticated;

-- Explicit, self-documenting belt-and-suspenders: these must never be
-- writable directly by a client, only through the SECURITY DEFINER
-- functions that already own each of these mutations. Revoking is a
-- no-op today (nothing was ever granted) but makes the intent durable
-- against a future migration accidentally granting more than SELECT.
revoke insert, update, delete on polls, questions, options,
  identified_responses, identified_answers, voter_eligibility,
  audit_log, org_admins from authenticated;
revoke all on platform_owners, anonymous_ballots, anonymous_ballot_answers
  from anon, authenticated;

-- ============================================================
-- save_poll_draft: the ONLY way an admin creates or edits a poll's
-- structure. One transaction — poll row, questions, and options all
-- succeed or all roll back together, because it's a single PL/pgSQL
-- function call (Postgres never partially commits a function body).
-- Pass p_poll_id = null to create a new draft; pass an existing draft's
-- id to replace its questions/options wholesale (only ever valid while
-- status = 'draft', same rule the old RLS policy enforced).
--
-- p_questions shape:
-- [{
--   "prompt": text, "question_type": text, "max_selections": int|null,
--   "allow_write_in": bool, "allow_abstain": bool, "required": bool,
--   "rating_min": int|null, "rating_max": int|null,
--   "options": [{"label": text, "slot_start": timestamptz|null,
--                "slot_end": timestamptz|null}, ...]
-- }, ...]
--
-- Yes/No questions always get exactly two server-generated options
-- (Yes/No) regardless of what's passed in "options" — this closes a
-- real bug where the frontend was submitting non-UUID synthetic ids for
-- yes/no answers, which would have failed validate_answers's uuid cast
-- outright. Abstain/write-in options are likewise always
-- server-generated when the corresponding flag is set, never trusted
-- from client-supplied option rows, so a client can't spoof or omit
-- them.
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
        values (v_new_q_id, v_oi, coalesce(nullif(v_o->>'label',''), to_char((v_o->>'slot_start')::timestamptz, 'Dy Mon DD, HH12:MI AM')),
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
