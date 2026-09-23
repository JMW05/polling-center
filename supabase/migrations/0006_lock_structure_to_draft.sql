-- Integrity hardening: once a poll has left 'draft', its questions/options
-- should be immutable via direct table access. Editing an option's label
-- after real votes/ballots reference it would silently change what past
-- responses mean; deleting one would cascade-delete answers. The intended
-- workflow for revising a published poll is duplicate_poll() into a new
-- draft, not live editing — so restrict direct admin table writes on
-- questions/options to polls still in 'draft'. Admin read access (any
-- status) is untouched — this only narrows the write policies.

drop policy if exists questions_admin_write on questions;
create policy questions_admin_write on questions for all
  to authenticated
  using (
    is_org_admin(auth.uid(), (select org_id from polls where polls.id = questions.poll_id))
    and (select status from polls where polls.id = questions.poll_id) = 'draft'
  )
  with check (
    is_org_admin(auth.uid(), (select org_id from polls where polls.id = questions.poll_id))
    and (select status from polls where polls.id = questions.poll_id) = 'draft'
  );

drop policy if exists options_admin_write on options;
create policy options_admin_write on options for all
  to authenticated
  using (
    is_org_admin(auth.uid(), (select p.org_id from polls p join questions q on q.poll_id = p.id where q.id = options.question_id))
    and (select p.status from polls p join questions q on q.poll_id = p.id where q.id = options.question_id) = 'draft'
  )
  with check (
    is_org_admin(auth.uid(), (select p.org_id from polls p join questions q on q.poll_id = p.id where q.id = options.question_id))
    and (select p.status from polls p join questions q on q.poll_id = p.id where q.id = options.question_id) = 'draft'
  );
