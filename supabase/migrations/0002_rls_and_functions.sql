-- Polling Center: RLS, authorization helpers, public-safe views, and
-- the SECURITY DEFINER functions that are the ONLY way to write votes.
-- No table here grants direct INSERT/UPDATE to anon or authenticated —
-- every write goes through a function below, so every rule (option
-- belongs to question, question belongs to poll, selection limits,
-- poll timing/status, one-credential-one-ballot) is enforced in one
-- place, server-side, no matter how the request arrives.

-- ============================================================
-- AUTHORIZATION HELPERS
-- ============================================================
create or replace function is_platform_owner(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from platform_owners where user_id = p_uid);
$$;

create or replace function is_org_admin(p_uid uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p_uid is not null and (
      exists (select 1 from platform_owners where user_id = p_uid)
      or exists (select 1 from org_admins where user_id = p_uid and org_id = p_org_id)
    );
$$;

grant execute on function is_platform_owner(uuid) to anon, authenticated;
grant execute on function is_org_admin(uuid, uuid) to anon, authenticated;

-- ============================================================
-- ENABLE RLS EVERYWHERE, THEN LOCK DOWN GRANTS
-- ============================================================
alter table organizations enable row level security;
alter table platform_owners enable row level security;
alter table org_admins enable row level security;
alter table polls enable row level security;
alter table questions enable row level security;
alter table options enable row level security;
alter table identified_responses enable row level security;
alter table identified_answers enable row level security;
alter table voter_eligibility enable row level security;
alter table anonymous_ballots enable row level security;
alter table anonymous_ballot_answers enable row level security;
alter table audit_log enable row level security;

revoke all on organizations, platform_owners, org_admins, polls, questions, options,
  identified_responses, identified_answers, voter_eligibility,
  anonymous_ballots, anonymous_ballot_answers, audit_log
  from anon, authenticated;

-- organizations: name/id are not sensitive — safe to read for the org switcher.
grant select on organizations to anon, authenticated;
create policy organizations_public_read on organizations for select
  using (true);
create policy organizations_admin_write on organizations for all
  using (is_platform_owner(auth.uid()))
  with check (is_platform_owner(auth.uid()));

-- platform_owners / org_admins: no direct client access at all — read only
-- through the helper functions above (which are SECURITY DEFINER and so
-- bypass RLS). Admin dashboards still need to see the admin roster for
-- their own org, so add narrow read policies for that.
create policy org_admins_self_or_org_read on org_admins for select
  to authenticated
  using (user_id = auth.uid() or is_org_admin(auth.uid(), org_id));
create policy org_admins_owner_write on org_admins for all
  to authenticated
  using (is_platform_owner(auth.uid()))
  with check (is_platform_owner(auth.uid()));

-- polls / questions / options: admins (of that poll's org) get full read on
-- the base tables; the public gets NOTHING on the base tables — they read
-- through the public_* views below instead, which expose only the columns
-- needed to render an eligible poll.
create policy polls_admin_read on polls for select
  to authenticated
  using (is_org_admin(auth.uid(), org_id));
create policy polls_admin_write on polls for all
  to authenticated
  using (is_org_admin(auth.uid(), org_id))
  with check (is_org_admin(auth.uid(), org_id));

create policy questions_admin_read on questions for select
  to authenticated
  using (is_org_admin(auth.uid(), (select org_id from polls where polls.id = questions.poll_id)));
create policy questions_admin_write on questions for all
  to authenticated
  using (is_org_admin(auth.uid(), (select org_id from polls where polls.id = questions.poll_id)))
  with check (is_org_admin(auth.uid(), (select org_id from polls where polls.id = questions.poll_id)));

create policy options_admin_read on options for select
  to authenticated
  using (is_org_admin(auth.uid(), (select p.org_id from polls p join questions q on q.poll_id = p.id where q.id = options.question_id)));
create policy options_admin_write on options for all
  to authenticated
  using (is_org_admin(auth.uid(), (select p.org_id from polls p join questions q on q.poll_id = p.id where q.id = options.question_id)))
  with check (is_org_admin(auth.uid(), (select p.org_id from polls p join questions q on q.poll_id = p.id where q.id = options.question_id)));

-- identified_responses / identified_answers: admin read only (needed for
-- the availability matrix, named comments, survey free text). No client
-- writes at all — only submit_identified_response() below.
create policy identified_responses_admin_read on identified_responses for select
  to authenticated
  using (is_org_admin(auth.uid(), (select org_id from polls where polls.id = identified_responses.poll_id)));
create policy identified_answers_admin_read on identified_answers for select
  to authenticated
  using (is_org_admin(auth.uid(), (select org_id from polls where polls.id = (select poll_id from identified_responses where identified_responses.id = identified_answers.response_id))));

-- voter_eligibility: admin can see label + used flag (roster monitoring),
-- but the token itself is only ever known at generation time — it's never
-- stored in plaintext, so there is nothing for even an admin to read back.
-- No UPDATE policy at all: only cast_anonymous_ballot() may flip `used`.
create policy voter_eligibility_admin_read on voter_eligibility for select
  to authenticated
  using (is_org_admin(auth.uid(), (select org_id from polls where polls.id = voter_eligibility.poll_id)));

-- anonymous_ballots / anonymous_ballot_answers: NO select policy for
-- anyone, admin included. The only way to learn anything about them is
-- the aggregate get_poll_results()/get_poll_admin_monitor() functions
-- below. This is what makes "admin cannot reconstruct voter-to-ballot
-- relationships" true at the database level, not just by convention.

-- audit_log: admin read only; writes only via log_audit() below.
create policy audit_log_admin_read on audit_log for select
  to authenticated
  using (is_org_admin(auth.uid(), org_id));

-- ============================================================
-- PUBLIC-SAFE VIEWS
-- Ordinary views (not security_invoker) run as their owner and so
-- bypass RLS on the underlying tables — the view's own WHERE clause
-- is the only gate. That's intentional here: it's how an anonymous
-- respondent gets exactly the columns needed to render an open poll,
-- nothing else (no created_by, no internal admin fields).
-- ============================================================
create view public_polls as
select id, org_id, title, description, poll_type, status, access_mode,
       anonymous, allow_change_vote, results_visibility,
       show_respondent_identities, open_at, close_at, timezone,
       final_option_id, closed_at
from polls
where status in ('open','closed');

create view public_questions as
select q.id, q.poll_id, q.order_index, q.prompt, q.question_type,
       q.max_selections, q.allow_write_in, q.allow_abstain, q.required,
       q.rating_min, q.rating_max
from questions q
join polls p on p.id = q.poll_id
where p.status in ('open','closed');

create view public_options as
select o.id, o.question_id, o.order_index, o.label, o.slot_start, o.slot_end,
       o.is_abstain, o.is_write_in
from options o
join questions q on q.id = o.question_id
join polls p on p.id = q.poll_id
where p.status in ('open','closed');

grant select on public_polls, public_questions, public_options to anon, authenticated;

-- ============================================================
-- AUDIT LOGGING HELPER (used internally by the functions below —
-- never called directly by a client, never carries ballot content)
-- ============================================================
create or replace function log_audit(p_org_id uuid, p_poll_id uuid, p_action text, p_details jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into audit_log (org_id, poll_id, actor, action, details)
  values (p_org_id, p_poll_id, auth.uid(), p_action, coalesce(p_details, '{}'::jsonb));
$$;

-- ============================================================
-- ANSWER VALIDATION (shared by both submission paths)
-- Raises an exception on any violation — nothing partial is ever
-- written, because the caller runs this inside its own function body
-- (same transaction).
-- ============================================================
create or replace function validate_answers(p_poll_id uuid, p_answers jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_answer jsonb;
  v_question record;
  v_option_ids uuid[];
  v_option_count int;
  v_valid_option_count int;
  v_seen_questions uuid[] := '{}';
begin
  if jsonb_typeof(p_answers) is distinct from 'array' then
    raise exception 'answers_must_be_array';
  end if;

  for v_answer in select * from jsonb_array_elements(p_answers)
  loop
    select * into v_question from questions
      where id = (v_answer->>'question_id')::uuid and poll_id = p_poll_id;
    if not found then
      raise exception 'question_not_in_poll';
    end if;
    if v_question.id = any(v_seen_questions) then
      raise exception 'duplicate_answer_for_question';
    end if;
    v_seen_questions := array_append(v_seen_questions, v_question.id);

    if v_question.question_type in ('single_select','multi_select','yesno','availability') then
      select coalesce(array_agg((elem)::uuid), '{}')
        into v_option_ids
        from jsonb_array_elements_text(coalesce(v_answer->'option_ids', '[]'::jsonb)) elem;

      v_option_count := coalesce(array_length(v_option_ids, 1), 0);

      if v_option_count = 0 then
        if v_question.required then
          raise exception 'question_requires_a_selection';
        end if;
      else
        select count(*) into v_valid_option_count
          from options where id = any(v_option_ids) and question_id = v_question.id;
        if v_valid_option_count <> v_option_count then
          raise exception 'option_not_in_question';
        end if;

        if v_question.question_type in ('single_select','yesno') and v_option_count > 1 then
          raise exception 'only_one_selection_allowed';
        end if;
        if v_question.max_selections is not null and v_option_count > v_question.max_selections then
          raise exception 'too_many_selections';
        end if;
      end if;

    elsif v_question.question_type = 'rating' then
      if v_answer->'rating_value' is null then
        if v_question.required then raise exception 'rating_required'; end if;
      else
        if (v_answer->>'rating_value')::int not between v_question.rating_min and v_question.rating_max then
          raise exception 'rating_out_of_range';
        end if;
      end if;

    elsif v_question.question_type = 'text' then
      if v_question.required and coalesce(trim(v_answer->>'text_answer'), '') = '' then
        raise exception 'text_answer_required';
      end if;
    end if;
  end loop;

  -- required questions that were skipped entirely
  if exists (
    select 1 from questions
    where poll_id = p_poll_id and required = true
      and id <> all (v_seen_questions)
  ) then
    raise exception 'missing_required_question';
  end if;
end;
$$;

-- ============================================================
-- SUBMIT_IDENTIFIED_RESPONSE
-- Covers access_mode in ('link','device','identified','restricted_list').
-- Never used for anonymous polls (see check below).
-- ============================================================
create or replace function submit_identified_response(
  p_poll_id uuid,
  p_dedup_key text,
  p_respondent_name text,
  p_respondent_email text,
  p_answers jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll record;
  v_response_id uuid;
  v_answer jsonb;
begin
  select * into v_poll from polls where id = p_poll_id for update;
  if not found then raise exception 'poll_not_found'; end if;
  if v_poll.anonymous then raise exception 'poll_is_anonymous_use_token_path'; end if;
  if v_poll.status <> 'open' then raise exception 'poll_not_open'; end if;
  if v_poll.open_at is not null and now() < v_poll.open_at then raise exception 'poll_not_open_yet'; end if;
  if v_poll.close_at is not null and now() > v_poll.close_at then raise exception 'poll_past_close'; end if;

  perform validate_answers(p_poll_id, p_answers);

  if p_dedup_key is not null then
    select id into v_response_id from identified_responses
      where poll_id = p_poll_id and dedup_key = p_dedup_key;
    if found then
      if not v_poll.allow_change_vote then
        raise exception 'already_responded';
      end if;
      update identified_responses
        set respondent_name = p_respondent_name,
            respondent_email = p_respondent_email,
            updated_at = now()
        where id = v_response_id;
      delete from identified_answers where response_id = v_response_id;
    end if;
  end if;

  if v_response_id is null then
    insert into identified_responses (poll_id, dedup_key, respondent_name, respondent_email)
      values (p_poll_id, p_dedup_key, p_respondent_name, p_respondent_email)
      returning id into v_response_id;
  end if;

  for v_answer in select * from jsonb_array_elements(p_answers)
  loop
    insert into identified_answers (response_id, question_id, option_ids, text_answer, rating_value, comment)
    values (
      v_response_id,
      (v_answer->>'question_id')::uuid,
      coalesce((select array_agg((elem)::uuid) from jsonb_array_elements_text(coalesce(v_answer->'option_ids','[]'::jsonb)) elem), '{}'),
      v_answer->>'text_answer',
      nullif(v_answer->>'rating_value','')::int,
      v_answer->>'comment'
    );
  end loop;

  return v_response_id;
end;
$$;

grant execute on function submit_identified_response(uuid, text, text, text, jsonb) to anon, authenticated;

-- ============================================================
-- CAST_ANONYMOUS_BALLOT
-- Token redemption + ballot insert in one transaction. The UPDATE
-- ... WHERE used = false is the atomic compare-and-swap: under
-- concurrent requests with the same token, Postgres row locking lets
-- exactly one succeed (affects 1 row) — the other sees 0 rows
-- affected and is rejected. Nothing in this function ever writes a
-- voter/token reference onto the ballot rows.
-- ============================================================
create or replace function cast_anonymous_ballot(
  p_poll_id uuid,
  p_token text,
  p_answers jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll record;
  v_token_hash text;
  v_elig_id uuid;
  v_updated int;
  v_ballot_id uuid;
  v_answer jsonb;
begin
  select * into v_poll from polls where id = p_poll_id;
  if not found then raise exception 'poll_not_found'; end if;
  if not v_poll.anonymous then raise exception 'poll_is_not_anonymous'; end if;
  if v_poll.status <> 'open' then raise exception 'poll_not_open'; end if;
  if v_poll.open_at is not null and now() < v_poll.open_at then raise exception 'poll_not_open_yet'; end if;
  if v_poll.close_at is not null and now() > v_poll.close_at then raise exception 'poll_past_close'; end if;
  if p_token is null or length(p_token) < 8 then raise exception 'invalid_token'; end if;

  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  select id into v_elig_id from voter_eligibility
    where poll_id = p_poll_id and token_hash = v_token_hash;
  if not found then raise exception 'invalid_token'; end if;

  perform validate_answers(p_poll_id, p_answers);

  -- atomic claim: only one concurrent caller can flip this row
  update voter_eligibility set used = true
    where id = v_elig_id and used = false;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'token_already_used';
  end if;

  insert into anonymous_ballots (poll_id) values (p_poll_id) returning id into v_ballot_id;

  for v_answer in select * from jsonb_array_elements(p_answers)
  loop
    insert into anonymous_ballot_answers (ballot_id, question_id, option_ids, text_answer)
    values (
      v_ballot_id,
      (v_answer->>'question_id')::uuid,
      coalesce((select array_agg((elem)::uuid) from jsonb_array_elements_text(coalesce(v_answer->'option_ids','[]'::jsonb)) elem), '{}'),
      v_answer->>'text_answer'
    );
  end loop;
end;
$$;

grant execute on function cast_anonymous_ballot(uuid, text, jsonb) to anon, authenticated;

-- ============================================================
-- ELECTION TOKEN GENERATION (admin only)
-- Returns the plaintext tokens ONCE, for the admin to export as CSV
-- and distribute. Only the hash is ever persisted.
-- ============================================================
create or replace function generate_election_tokens(p_poll_id uuid, p_labels text[])
returns table (label text, token text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_label text;
  v_token text;
begin
  select org_id into v_org_id from polls where id = p_poll_id;
  if v_org_id is null then raise exception 'poll_not_found'; end if;
  if not is_org_admin(auth.uid(), v_org_id) then raise exception 'not_authorized'; end if;

  foreach v_label in array p_labels
  loop
    v_token := encode(gen_random_bytes(9), 'base64');
    v_token := replace(replace(replace(v_token, '/', '_'), '+', '-'), '=', '');
    insert into voter_eligibility (poll_id, token_hash, label)
      values (p_poll_id, encode(digest(v_token, 'sha256'), 'hex'), v_label);
    label := v_label;
    token := v_token;
    return next;
  end loop;

  perform log_audit(v_org_id, p_poll_id, 'election_credentials_generated',
    jsonb_build_object('count', array_length(p_labels, 1)));
end;
$$;

grant execute on function generate_election_tokens(uuid, text[]) to authenticated;

-- ============================================================
-- RESULTS: get_poll_results (public-safe, same rules for every caller
-- including admins) and get_poll_admin_monitor (admin-only, turnout
-- counts for elections without ever revealing tallies or ballots).
-- ============================================================
create or replace function get_poll_results(p_poll_id uuid, p_dedup_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll record;
  v_is_admin boolean;
  v_visible boolean;
  v_has_responded boolean := false;
  v_questions jsonb;
begin
  select * into v_poll from polls where id = p_poll_id;
  if not found then
    return jsonb_build_object('visible', false, 'reason', 'not_found');
  end if;

  v_is_admin := is_org_admin(auth.uid(), v_poll.org_id);

  -- Hard rule, no bypass for anyone: an election never reveals anything
  -- beyond "it exists" until it is closed.
  if v_poll.poll_type = 'election' and v_poll.status <> 'closed' then
    return jsonb_build_object('visible', false, 'reason', 'election_not_closed');
  end if;

  if v_poll.status in ('draft','scheduled') then
    return jsonb_build_object('visible', false, 'reason', 'not_open_yet');
  end if;

  if p_dedup_key is not null then
    v_has_responded := exists (
      select 1 from identified_responses
      where poll_id = p_poll_id and dedup_key = p_dedup_key
    );
  end if;

  v_visible := case v_poll.results_visibility
    when 'admin_only'   then v_is_admin
    when 'after_close'  then v_poll.status = 'closed'
    when 'while_open'   then v_poll.status in ('open','closed')
    when 'manual'       then v_poll.results_released_at is not null
    when 'after_voting' then v_has_responded or v_is_admin
    else false
  end;

  if not v_visible then
    return jsonb_build_object('visible', false, 'reason', 'not_yet_visible');
  end if;

  if v_poll.anonymous then
    select jsonb_agg(jsonb_build_object(
      'question_id', q.id,
      'prompt', q.prompt,
      'question_type', q.question_type,
      'options', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'option_id', o.id, 'label', o.label,
                 'slot_start', o.slot_start, 'slot_end', o.slot_end,
                 'votes', (
                   select count(*) from anonymous_ballot_answers aba
                   where aba.question_id = q.id and o.id = any(aba.option_ids)
                 )
               ) order by o.order_index), '[]'::jsonb)
        from options o where o.question_id = q.id
      )
    ) order by q.order_index)
    into v_questions
    from questions q where q.poll_id = p_poll_id;
  else
    select jsonb_agg(jsonb_build_object(
      'question_id', q.id,
      'prompt', q.prompt,
      'question_type', q.question_type,
      'options', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'option_id', o.id, 'label', o.label,
                 'slot_start', o.slot_start, 'slot_end', o.slot_end,
                 'votes', (
                   select count(*) from identified_answers ia
                   where ia.question_id = q.id and o.id = any(ia.option_ids)
                 )
               ) order by o.order_index), '[]'::jsonb)
        from options o where o.question_id = q.id
      ),
      'text_answers', case when q.question_type = 'text' then (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'text', ia.text_answer,
                 'respondent', case when v_poll.show_respondent_identities
                                     then coalesce(ir.respondent_name, ir.respondent_email)
                                     else null end
               )), '[]'::jsonb)
        from identified_answers ia
        join identified_responses ir on ir.id = ia.response_id
        where ia.question_id = q.id and coalesce(trim(ia.text_answer), '') <> ''
      ) else null end
    ) order by q.order_index)
    into v_questions
    from questions q where q.poll_id = p_poll_id;
  end if;

  return jsonb_build_object(
    'visible', true,
    'poll_status', v_poll.status,
    'anonymous', v_poll.anonymous,
    'total_responses', case when v_poll.anonymous
      then (select count(*) from anonymous_ballots where poll_id = p_poll_id)
      else (select count(*) from identified_responses where poll_id = p_poll_id) end,
    'final_option_id', v_poll.final_option_id,
    'questions', coalesce(v_questions, '[]'::jsonb)
  );
end;
$$;

grant execute on function get_poll_results(uuid, text) to anon, authenticated;

-- Admin-only participation monitor. For elections this NEVER touches
-- anonymous_ballots — only voter_eligibility counts — so watching
-- turnout climb during an open election never exposes a tally.
create or replace function get_poll_admin_monitor(p_poll_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll record;
begin
  select * into v_poll from polls where id = p_poll_id;
  if not found then raise exception 'poll_not_found'; end if;
  if not is_org_admin(auth.uid(), v_poll.org_id) then raise exception 'not_authorized'; end if;

  if v_poll.poll_type = 'election' then
    return jsonb_build_object(
      'mode', 'election_turnout',
      'eligible_count', (select count(*) from voter_eligibility where poll_id = p_poll_id),
      'cast_count', (select count(*) from voter_eligibility where poll_id = p_poll_id and used = true)
    );
  elsif v_poll.anonymous then
    return jsonb_build_object(
      'mode', 'anonymous_participation',
      'response_count', (select count(*) from anonymous_ballots where poll_id = p_poll_id)
    );
  else
    return jsonb_build_object(
      'mode', 'identified_participation',
      'response_count', (select count(*) from identified_responses where poll_id = p_poll_id)
    );
  end if;
end;
$$;

grant execute on function get_poll_admin_monitor(uuid) to authenticated;

-- ============================================================
-- ADMIN LIFECYCLE ACTIONS (status changes, duplication, release)
-- ============================================================
create or replace function publish_poll(p_poll_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid; v_status text;
begin
  select org_id, status into v_org, v_status from polls where id = p_poll_id;
  if v_org is null then raise exception 'poll_not_found'; end if;
  if not is_org_admin(auth.uid(), v_org) then raise exception 'not_authorized'; end if;
  if v_status not in ('draft','scheduled') then raise exception 'poll_not_in_draft_or_scheduled'; end if;
  update polls set status = 'open', published_at = coalesce(published_at, now()), updated_at = now()
    where id = p_poll_id;
  perform log_audit(v_org, p_poll_id, 'poll_published', '{}'::jsonb);
end; $$;

create or replace function close_poll(p_poll_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select org_id into v_org from polls where id = p_poll_id;
  if v_org is null then raise exception 'poll_not_found'; end if;
  if not is_org_admin(auth.uid(), v_org) then raise exception 'not_authorized'; end if;
  update polls set status = 'closed', closed_at = now(), updated_at = now() where id = p_poll_id;
  perform log_audit(v_org, p_poll_id, 'poll_closed', '{}'::jsonb);
end; $$;

create or replace function reopen_poll(p_poll_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid; v_type text;
begin
  select org_id, poll_type into v_org, v_type from polls where id = p_poll_id;
  if v_org is null then raise exception 'poll_not_found'; end if;
  if not is_org_admin(auth.uid(), v_org) then raise exception 'not_authorized'; end if;
  if v_type = 'election' then raise exception 'elections_cannot_be_reopened'; end if;
  update polls set status = 'open', closed_at = null, updated_at = now() where id = p_poll_id;
  perform log_audit(v_org, p_poll_id, 'poll_reopened', '{}'::jsonb);
end; $$;

create or replace function archive_poll(p_poll_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select org_id into v_org from polls where id = p_poll_id;
  if v_org is null then raise exception 'poll_not_found'; end if;
  if not is_org_admin(auth.uid(), v_org) then raise exception 'not_authorized'; end if;
  update polls set status = 'archived', archived_at = now(), updated_at = now() where id = p_poll_id;
  perform log_audit(v_org, p_poll_id, 'poll_archived', '{}'::jsonb);
end; $$;

create or replace function release_results(p_poll_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select org_id into v_org from polls where id = p_poll_id;
  if v_org is null then raise exception 'poll_not_found'; end if;
  if not is_org_admin(auth.uid(), v_org) then raise exception 'not_authorized'; end if;
  update polls set results_released_at = now(), updated_at = now() where id = p_poll_id;
  perform log_audit(v_org, p_poll_id, 'results_released', '{}'::jsonb);
end; $$;

create or replace function set_final_option(p_poll_id uuid, p_option_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select org_id into v_org from polls where id = p_poll_id;
  if v_org is null then raise exception 'poll_not_found'; end if;
  if not is_org_admin(auth.uid(), v_org) then raise exception 'not_authorized'; end if;
  if p_option_id is not null and not exists (
    select 1 from options o join questions q on q.id = o.question_id
    where o.id = p_option_id and q.poll_id = p_poll_id
  ) then
    raise exception 'option_not_in_poll';
  end if;
  update polls set final_option_id = p_option_id, updated_at = now() where id = p_poll_id;
  perform log_audit(v_org, p_poll_id, 'final_meeting_time_selected', jsonb_build_object('option_id', p_option_id));
end; $$;

-- Duplicate a poll's structure (questions/options/settings) into a new
-- draft poll. Never copies responses/ballots/eligibility.
create or replace function duplicate_poll(p_poll_id uuid, p_new_title text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_src record;
  v_new_id uuid;
  v_q record;
  v_new_q_id uuid;
  v_o record;
begin
  select * into v_src from polls where id = p_poll_id;
  if v_src.id is null then raise exception 'poll_not_found'; end if;
  if not is_org_admin(auth.uid(), v_src.org_id) then raise exception 'not_authorized'; end if;

  insert into polls (org_id, title, description, poll_type, status, access_mode, anonymous,
                      allow_change_vote, results_visibility, show_respondent_identities,
                      timezone, created_by)
  values (v_src.org_id, p_new_title, v_src.description, v_src.poll_type, 'draft', v_src.access_mode,
          v_src.anonymous, v_src.allow_change_vote, v_src.results_visibility, v_src.show_respondent_identities,
          v_src.timezone, auth.uid())
  returning id into v_new_id;

  for v_q in select * from questions where poll_id = p_poll_id order by order_index
  loop
    insert into questions (poll_id, order_index, prompt, question_type, max_selections,
                            allow_write_in, allow_abstain, required, rating_min, rating_max)
    values (v_new_id, v_q.order_index, v_q.prompt, v_q.question_type, v_q.max_selections,
            v_q.allow_write_in, v_q.allow_abstain, v_q.required, v_q.rating_min, v_q.rating_max)
    returning id into v_new_q_id;

    for v_o in select * from options where question_id = v_q.id order by order_index
    loop
      insert into options (question_id, order_index, label, slot_start, slot_end, is_abstain, is_write_in)
      values (v_new_q_id, v_o.order_index, v_o.label, v_o.slot_start, v_o.slot_end, v_o.is_abstain, v_o.is_write_in);
    end loop;
  end loop;

  perform log_audit(v_src.org_id, v_new_id, 'poll_duplicated', jsonb_build_object('source_poll_id', p_poll_id));
  return v_new_id;
end; $$;

grant execute on function publish_poll(uuid) to authenticated;
grant execute on function close_poll(uuid) to authenticated;
grant execute on function reopen_poll(uuid) to authenticated;
grant execute on function archive_poll(uuid) to authenticated;
grant execute on function release_results(uuid) to authenticated;
grant execute on function set_final_option(uuid, uuid) to authenticated;
grant execute on function duplicate_poll(uuid, text) to authenticated;

-- ============================================================
-- ORG / ADMIN MANAGEMENT
-- ============================================================
create or replace function create_organization(p_name text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not is_platform_owner(auth.uid()) then raise exception 'not_authorized'; end if;
  insert into organizations (name) values (p_name) returning id into v_id;
  perform log_audit(v_id, null, 'organization_created', jsonb_build_object('name', p_name));
  return v_id;
end; $$;

create or replace function add_org_admin(p_org_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_owner(auth.uid()) then raise exception 'not_authorized'; end if;
  insert into org_admins (org_id, user_id) values (p_org_id, p_user_id)
    on conflict (org_id, user_id) do nothing;
  perform log_audit(p_org_id, null, 'org_admin_added', jsonb_build_object('user_id', p_user_id));
end; $$;

-- One-time, self-service bootstrap: the very first authenticated user
-- to call this becomes platform owner; it refuses once anyone already
-- holds that role. This is how the admin account gets created without
-- ever handing a service-role key to anyone.
create or replace function bootstrap_platform_owner()
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if exists (select 1 from platform_owners) then raise exception 'already_bootstrapped'; end if;
  insert into platform_owners (user_id) values (auth.uid());
  return true;
end; $$;

grant execute on function create_organization(text) to authenticated;
grant execute on function add_org_admin(uuid, uuid) to authenticated;
grant execute on function bootstrap_platform_owner() to authenticated;
