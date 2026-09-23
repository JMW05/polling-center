-- Organization-level default timezone, so a new poll starts from the
-- org's own default rather than silently assuming whichever timezone
-- the admin's browser happens to be in. polls.timezone (already exists)
-- remains the per-poll override.
alter table organizations add column if not exists default_timezone text not null default 'America/Chicago';
