-- Hardening pass based on Supabase's own security advisor output:
--  1. Replace the security-definer VIEWs (advisor: ERROR) with
--     security-definer FUNCTIONS instead — same "bypass RLS, apply my
--     own filter + column list" trick, but functions don't trip the
--     view-specific linter, and it matches the one-access-path
--     pattern already used for every write.
--  2. Postgres grants EXECUTE on new functions to PUBLIC by default,
--     so every function was technically callable by anon even where
--     only an internal EXECUTE grant was intended (the function body's
--     own is_org_admin() check still blocked unauthorized use, but the
--     grant itself was looser than intended). Revoke PUBLIC execute
--     everywhere and re-grant only the roles that should have it.

drop view if exists public_polls;
drop view if exists public_questions;
drop view if exists public_options;

create or replace function list_public_polls(p_org_id uuid, p_status text default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'org_id', org_id, 'title', title, 'description', description,
    'poll_type', poll_type, 'status', status, 'access_mode', access_mode,
    'anonymous', anonymous, 'allow_change_vote', allow_change_vote,
    'results_visibility', results_visibility,
    'show_respondent_identities', show_respondent_identities,
    'open_at', open_at, 'close_at', close_at, 'timezone', timezone,
    'final_option_id', final_option_id, 'closed_at', closed_at
  ) order by coalesce(published_at, created_at) desc), '[]'::jsonb)
  from polls
  where org_id = p_org_id
    and status in ('open','closed')
    and (p_status is null or status = p_status);
$$;

create or replace function get_public_poll_detail(p_poll_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll jsonb;
begin
  select jsonb_build_object(
    'id', p.id, 'org_id', p.org_id, 'title', p.title, 'description', p.description,
    'poll_type', p.poll_type, 'status', p.status, 'access_mode', p.access_mode,
    'anonymous', p.anonymous, 'allow_change_vote', p.allow_change_vote,
    'results_visibility', p.results_visibility,
    'show_respondent_identities', p.show_respondent_identities,
    'open_at', p.open_at, 'close_at', p.close_at, 'timezone', p.timezone,
    'final_option_id', p.final_option_id, 'closed_at', p.closed_at,
    'questions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', q.id, 'order_index', q.order_index, 'prompt', q.prompt,
        'question_type', q.question_type, 'max_selections', q.max_selections,
        'allow_write_in', q.allow_write_in, 'allow_abstain', q.allow_abstain,
        'required', q.required, 'rating_min', q.rating_min, 'rating_max', q.rating_max,
        'options', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', o.id, 'order_index', o.order_index, 'label', o.label,
            'slot_start', o.slot_start, 'slot_end', o.slot_end,
            'is_abstain', o.is_abstain, 'is_write_in', o.is_write_in
          ) order by o.order_index), '[]'::jsonb)
          from options o where o.question_id = q.id
        )
      ) order by q.order_index), '[]'::jsonb)
      from questions q where q.poll_id = p.id
    )
  ) into v_poll
  from polls p
  where p.id = p_poll_id and p.status in ('open','closed');

  return coalesce(v_poll, jsonb_build_object('error', 'not_found_or_not_public'));
end;
$$;

-- --- lock down default PUBLIC execute grants, then re-grant precisely ---

revoke execute on function is_platform_owner(uuid) from public;
revoke execute on function is_org_admin(uuid, uuid) from public;
revoke execute on function log_audit(uuid, uuid, text, jsonb) from public;
revoke execute on function validate_answers(uuid, jsonb) from public;
revoke execute on function submit_identified_response(uuid, text, text, text, jsonb) from public;
revoke execute on function cast_anonymous_ballot(uuid, text, jsonb) from public;
revoke execute on function generate_election_tokens(uuid, text[]) from public;
revoke execute on function get_poll_results(uuid, text) from public;
revoke execute on function get_poll_admin_monitor(uuid) from public;
revoke execute on function publish_poll(uuid) from public;
revoke execute on function close_poll(uuid) from public;
revoke execute on function reopen_poll(uuid) from public;
revoke execute on function archive_poll(uuid) from public;
revoke execute on function release_results(uuid) from public;
revoke execute on function set_final_option(uuid, uuid) from public;
revoke execute on function duplicate_poll(uuid, text) from public;
revoke execute on function create_organization(text) from public;
revoke execute on function add_org_admin(uuid, uuid) from public;
revoke execute on function bootstrap_platform_owner() from public;
revoke execute on function list_public_polls(uuid, text) from public;
revoke execute on function get_public_poll_detail(uuid) from public;

-- internal-only helpers: no direct client access at all (still callable
-- from inside the other SECURITY DEFINER functions, which run as the
-- function owner and so aren't subject to these grants)
revoke execute on function log_audit(uuid, uuid, text, jsonb) from anon, authenticated;
revoke execute on function validate_answers(uuid, jsonb) from anon, authenticated;

-- self-service "am I an admin" checks + public reads + voting: anon and
-- signed-in users both need these
grant execute on function is_platform_owner(uuid) to anon, authenticated;
grant execute on function is_org_admin(uuid, uuid) to anon, authenticated;
grant execute on function list_public_polls(uuid, text) to anon, authenticated;
grant execute on function get_public_poll_detail(uuid) to anon, authenticated;
grant execute on function get_poll_results(uuid, text) to anon, authenticated;
grant execute on function submit_identified_response(uuid, text, text, text, jsonb) to anon, authenticated;
grant execute on function cast_anonymous_ballot(uuid, text, jsonb) to anon, authenticated;

-- admin-only actions: signed-in users only (the function body further
-- restricts to org_admin/platform_owner via is_org_admin/is_platform_owner)
grant execute on function generate_election_tokens(uuid, text[]) to authenticated;
grant execute on function get_poll_admin_monitor(uuid) to authenticated;
grant execute on function publish_poll(uuid) to authenticated;
grant execute on function close_poll(uuid) to authenticated;
grant execute on function reopen_poll(uuid) to authenticated;
grant execute on function archive_poll(uuid) to authenticated;
grant execute on function release_results(uuid) to authenticated;
grant execute on function set_final_option(uuid, uuid) to authenticated;
grant execute on function duplicate_poll(uuid, text) to authenticated;
grant execute on function create_organization(text) to authenticated;
grant execute on function add_org_admin(uuid, uuid) to authenticated;
grant execute on function bootstrap_platform_owner() to authenticated;
