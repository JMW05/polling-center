-- ============================================================
-- RECONSTRUCTED MIGRATION — see note below.
--
-- Applied against the live project as "0012_fix_pgcrypto_search_path"
-- (20260914004240) before this repository existed, so no original
-- file was saved to disk at the time. Reconstructed here, read-only,
-- from the function definitions currently live on the project
-- (`pg_get_functiondef`) — this is not a re-run against production,
-- just a faithful recreation of what is already there, for the
-- repository's migration history.
--
-- WHAT IT FIXED: cast_anonymous_ballot() and generate_election_tokens()
-- call pgcrypto's digest()/gen_random_bytes(). On this Supabase
-- project pgcrypto is installed into the `extensions` schema, not
-- `public`. Both functions are SECURITY DEFINER with an explicit
-- `SET search_path`, and that search_path had been left as
-- `'public', 'pg_temp'` (copied from the project's other
-- SECURITY DEFINER functions, most of which never call an extension
-- function) — so pgcrypto's functions were not resolvable inside
-- them. This made every election's voter-token generation and every
-- anonymous ballot submission fail outright: `generate_election_tokens`
-- and `cast_anonymous_ballot` were completely non-functional until
-- this fix. (No results, structure, or access-control logic was
-- affected — this was purely a name-resolution failure that caused
-- the functions to error before doing anything.)
--
-- THE FIX: add `'extensions'` to each function's search_path, so
-- pgcrypto's functions resolve correctly while keeping the same
-- SECURITY DEFINER hardening (an explicit, closed search_path — never
-- the caller's) that every RPC in this project uses.
-- ============================================================

create or replace function cast_anonymous_ballot(p_poll_id uuid, p_token text, p_answers jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
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

revoke execute on function cast_anonymous_ballot(uuid, text, jsonb) from public;
grant execute on function cast_anonymous_ballot(uuid, text, jsonb) to anon, authenticated;

create or replace function generate_election_tokens(p_poll_id uuid, p_labels text[])
returns table(label text, token text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
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

revoke execute on function generate_election_tokens(uuid, text[]) from public;
grant execute on function generate_election_tokens(uuid, text[]) to authenticated;
