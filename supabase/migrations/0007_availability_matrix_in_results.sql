-- Adds the per-respondent availability matrix to get_poll_results for
-- identified (non-anonymous) meeting-availability polls, but ONLY when
-- the poll's own show_respondent_identities setting is on — this is a
-- separate setting from results_visibility by design (per the identified-
-- response privacy requirement: result visibility and respondent-identity
-- visibility are independent). Anonymous polls and polls with identities
-- hidden get aggregate counts only, unchanged from before. Everything
-- else in the function (visibility gating, election lockout, admin_only,
-- etc.) is unchanged.

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
                 ),
                 -- Per-respondent availability, only for availability
                 -- questions on polls that have explicitly opted in to
                 -- showing respondent identities. Independent of
                 -- results_visibility, per design.
                 'available_respondents', case
                   when q.question_type = 'availability' and v_poll.show_respondent_identities then (
                     select coalesce(jsonb_agg(coalesce(ir.respondent_name, ir.respondent_email, 'Anonymous')
                              order by coalesce(ir.respondent_name, ir.respondent_email, '')), '[]'::jsonb)
                     from identified_answers ia
                     join identified_responses ir on ir.id = ia.response_id
                     where ia.question_id = q.id and o.id = any(ia.option_ids)
                   )
                   else null
                 end
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

-- create or replace preserves the existing grants (anon, authenticated),
-- but re-assert explicitly so this migration is correct standalone too.
grant execute on function get_poll_results(uuid, text) to anon, authenticated;
revoke execute on function get_poll_results(uuid, text) from public;
