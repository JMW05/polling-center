-- Prevents a race where the first stranger to find the public URL claims
-- platform owner. bootstrap_platform_owner() now only succeeds for the
-- specific, pre-authorized email — everyone else gets 'not_authorized'
-- even if no owner exists yet. The "only works once ever" rule from
-- before is unchanged and still enforced.
--
-- auth.jwt() ->> 'email' reads the caller's verified email straight off
-- their Supabase Auth session — there is no client-suppliable field that
-- can spoof this from the browser.

create or replace function bootstrap_platform_owner()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if exists (select 1 from platform_owners) then raise exception 'already_bootstrapped'; end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email <> 'janamw05@gmail.com' then
    raise exception 'not_authorized';
  end if;

  insert into platform_owners (user_id) values (auth.uid());
  perform log_audit(null, null, 'platform_owner_bootstrapped', jsonb_build_object('email', v_email));
  return true;
end; $$;

revoke execute on function bootstrap_platform_owner() from public;
grant execute on function bootstrap_platform_owner() to authenticated;
