-- Two real fixes to get_poll_results:
--
-- 1. Percentage math. The old version's only usable denominator was the
--    sum of votes across all options in a question. For a single-select
--    question that happens to equal the number of respondents who
--    answered (each contributes exactly one vote) — but for
--    multi-select and availability questions, one respondent can select
--    several options, so summing votes overcounts and understates every
--    percentage. Fix: return `respondents_answering` per question (a
--    distinct count of respondents/ballots with an answer row for that
--    question), and use THAT as the denominator uniformly for every
--    question type. For single-select it's numerically identical to the
--    old denominator; for multi-select/availability it's now correct —
--    8 of 10 respondents picking Tuesday now reads 80%, regardless of
--    how many other slots those 8 also picked.
--
-- 2. Rating questions previously had no results at all — they have no
--    option rows (validate_answers stores rating_value directly, not
--    option_ids), so the generic options-builder always produced an
--    empty array and the UI had nothing to render. Now returns an
--    average, a count, and a full distribution.

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
      'respondents_answering', (
        select count(distinct aba.ballot_id) from anonymous_ballot_answers aba where aba.question_id = q.id
      ),
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
      ),
      'rating', case when q.question_type = 'rating' then (
        select jsonb_build_object(
          'count', count(*),
          'average', round(avg(aba.text_answer::numeric), 2),
          'distribution', (
            select coalesce(jsonb_agg(jsonb_build_object('value', v, 'count', cnt) order by v), '[]'::jsonb)
            from (
              select aba2.text_answer::int as v, count(*) as cnt
              from anonymous_ballot_answers aba2
              where aba2.question_id = q.id and aba2.text_answer is not null
              group by aba2.text_answer::int
            ) dist
          )
        )
        from anonymous_ballot_answers aba where aba.question_id = q.id and aba.text_answer is not null
      ) else null end
    ) order by q.order_index)
    into v_questions
    from questions q where q.poll_id = p_poll_id;
  else
    select jsonb_agg(jsonb_build_object(
      'question_id', q.id,
      'prompt', q.prompt,
      'question_type', q.question_type,
      'respondents_answering', (
        select count(distinct ia.response_id) from identified_answers ia where ia.question_id = q.id
      ),
      'options', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'option_id', o.id, 'label', o.label,
                 'slot_start', o.slot_start, 'slot_end', o.slot_end,
                 'votes', (
                   select count(*) from identified_answers ia
                   where ia.question_id = q.id and o.id = any(ia.option_ids)
                 ),
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
      ) else null end,
      'rating', case when q.question_type = 'rating' then (
        select jsonb_build_object(
          'count', count(*),
          'average', round(avg(ia.rating_value), 2),
          'distribution', (
            select coalesce(jsonb_agg(jsonb_build_object('value', v, 'count', cnt) order by v), '[]'::jsonb)
            from (
              select ia2.rating_value as v, count(*) as cnt
              from identified_answers ia2
              where ia2.question_id = q.id and ia2.rating_value is not null
              group by ia2.rating_value
            ) dist
          )
        )
        from identified_answers ia where ia.question_id = q.id and ia.rating_value is not null
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
revoke execute on function get_poll_results(uuid, text) from public;
