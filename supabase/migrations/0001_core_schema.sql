-- Polling Center: core schema
-- Design notes are in /supabase/README.md (kept alongside the deployed repo).

create extension if not exists pgcrypto;

-- ============================================================
-- ORGANIZATIONS
-- ============================================================
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ADMIN AUTHORIZATION
-- Two roles: platform_owner (all orgs) and org_admin (scoped to
-- specific organizations). Kept in dedicated tables, never exposed
-- directly to anon/authenticated clients — only read through
-- SECURITY DEFINER helper functions (see 0002_rls_and_functions.sql).
-- ============================================================
create table platform_owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table org_admins (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'org_admin' check (role in ('org_admin')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

-- ============================================================
-- POLLS
-- ============================================================
create table polls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  title text not null check (char_length(trim(title)) > 0),
  description text not null default '',
  poll_type text not null check (poll_type in ('meeting','choice','election','survey')),
  status text not null default 'draft'
    check (status in ('draft','scheduled','open','closed','archived')),

  access_mode text not null default 'link'
    check (access_mode in ('link','device','identified','restricted_list','token')),
  anonymous boolean not null default false,
  allow_change_vote boolean not null default false,

  results_visibility text not null default 'after_close'
    check (results_visibility in ('admin_only','after_voting','while_open','after_close','manual')),
  results_released_at timestamptz,
  show_respondent_identities boolean not null default false,

  open_at timestamptz,
  close_at timestamptz,
  timezone text not null default 'America/Chicago',

  -- filled in once options exists (see below)
  final_option_id uuid,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  closed_at timestamptz,
  archived_at timestamptz,

  constraint close_after_open check (open_at is null or close_at is null or close_at > open_at),

  -- Elections must never be configured to leak live totals while open.
  constraint election_no_live_results check (
    poll_type <> 'election' or results_visibility <> 'while_open'
  ),
  -- Elections must use a controlled access mode, never bare link/device.
  constraint election_needs_controlled_access check (
    poll_type <> 'election' or access_mode in ('token','restricted_list')
  ),
  -- Elections are always anonymous — the secret-ballot guarantee is not optional.
  constraint election_is_anonymous check (
    poll_type <> 'election' or anonymous = true
  )
);

create index polls_org_idx on polls (org_id);
create index polls_status_idx on polls (status);

-- ============================================================
-- QUESTIONS  (a poll has 1+ questions; a meeting-availability slot
-- picker is modeled as ONE question of type 'availability' whose
-- OPTIONS are the individual date/time slots — not one question per
-- slot. Elections model each race/office as its own question.)
-- ============================================================
create table questions (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  order_index int not null default 0,
  prompt text not null check (char_length(trim(prompt)) > 0),
  question_type text not null
    check (question_type in ('single_select','multi_select','yesno','rating','text','availability')),
  max_selections int check (max_selections is null or max_selections >= 1),
  allow_write_in boolean not null default false,
  allow_abstain boolean not null default false,
  required boolean not null default true,
  rating_min int,
  rating_max int,
  created_at timestamptz not null default now(),
  unique (poll_id, order_index),
  constraint single_select_is_single check (
    question_type <> 'single_select' or max_selections is null or max_selections = 1
  ),
  constraint rating_bounds check (
    question_type <> 'rating' or (rating_min is not null and rating_max is not null and rating_min < rating_max)
  )
);

create index questions_poll_idx on questions (poll_id);

-- ============================================================
-- OPTIONS (candidates, choices, or availability slots)
-- ============================================================
create table options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  order_index int not null default 0,
  label text not null check (char_length(trim(label)) > 0),
  slot_start timestamptz,
  slot_end timestamptz,
  is_abstain boolean not null default false,
  is_write_in boolean not null default false,
  created_at timestamptz not null default now(),
  unique (question_id, order_index)
);

create index options_question_idx on options (question_id);

alter table polls
  add constraint polls_final_option_fk
  foreign key (final_option_id) references options(id) on delete set null;

-- ============================================================
-- IDENTIFIED RESPONSES  (every non-anonymous response: link / device /
-- identified / restricted_list access modes all land here. "Device"
-- dedup and "identified" dedup are both expressed through dedup_key —
-- this *is* the low-risk device-vote control, just not a separate
-- table, since the only real difference is what dedup_key holds.)
-- ============================================================
create table identified_responses (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  dedup_key text,                 -- device token, or lower(email)/name — null for pure "anyone with link, no dedup"
  respondent_name text,
  respondent_email text,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index identified_responses_poll_idx on identified_responses (poll_id);
-- one row per dedup_key per poll, but only enforced when a dedup_key exists
create unique index identified_responses_dedup_uq
  on identified_responses (poll_id, dedup_key) where dedup_key is not null;

create table identified_answers (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references identified_responses(id) on delete cascade,
  question_id uuid not null references questions(id) on delete cascade,
  option_ids uuid[] not null default '{}',
  text_answer text,
  rating_value int,
  comment text,
  unique (response_id, question_id)
);

create index identified_answers_response_idx on identified_answers (response_id);
create index identified_answers_question_idx on identified_answers (question_id);

-- ============================================================
-- VOTER ELIGIBILITY  (single-use credentials for token-gated /
-- restricted-list polls, chiefly elections). Deliberately holds NO
-- timestamp for when a token was redeemed — only a used boolean —
-- so it cannot be time-correlated against anonymous_ballots.
-- ============================================================
create table voter_eligibility (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  token_hash text not null,       -- sha256 hex of the credential; the plaintext token is never stored
  label text,                     -- admin-visible roster label (name/email) — NOT the token
  used boolean not null default false,
  created_at timestamptz not null default now(),
  unique (poll_id, token_hash)
);

create index voter_eligibility_poll_idx on voter_eligibility (poll_id);

-- ============================================================
-- ANONYMOUS BALLOTS  (elections, and any poll explicitly marked
-- anonymous). No voter id, email, token/hash, device id, IP, or
-- timestamp of any kind is stored here — nothing to link back to
-- voter_eligibility. cast_batch is a random grouping key only,
-- generated independently of anything voter-related.
-- ============================================================
create table anonymous_ballots (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  cast_batch uuid not null default gen_random_uuid()
);

create index anonymous_ballots_poll_idx on anonymous_ballots (poll_id);

create table anonymous_ballot_answers (
  id uuid primary key default gen_random_uuid(),
  ballot_id uuid not null references anonymous_ballots(id) on delete cascade,
  question_id uuid not null references questions(id) on delete cascade,
  option_ids uuid[] not null default '{}',
  text_answer text,
  unique (ballot_id, question_id)
);

create index anonymous_ballot_answers_ballot_idx on anonymous_ballot_answers (ballot_id);
create index anonymous_ballot_answers_question_idx on anonymous_ballot_answers (question_id);

-- ============================================================
-- AUDIT LOG (admin actions only — never vote/ballot content)
-- ============================================================
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  poll_id uuid references polls(id) on delete set null,
  actor uuid references auth.users(id),
  action text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_log_org_idx on audit_log (org_id);
create index audit_log_poll_idx on audit_log (poll_id);
