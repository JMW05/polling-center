-- Corrective fix for a gap left by 0003_advisor_hardening.sql.
--
-- 0003 revoked EXECUTE "from public" on every function, then re-granted
-- explicitly per role. That worked for functions whose ONLY grant came
-- from the PUBLIC pseudo-role. But Supabase's project-level default
-- privileges (ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO
-- anon, authenticated, service_role) grant EXECUTE directly to the named
-- roles at CREATE FUNCTION time — not through PUBLIC — so "revoke ...
-- from public" was a no-op against that grant. Net effect: every
-- admin-only function (publish_poll, close_poll, archive_poll,
-- generate_election_tokens, bootstrap_platform_owner, create_organization,
-- add_org_admin, duplicate_poll, release_results, reopen_poll,
-- set_final_option, get_poll_admin_monitor) was still directly executable
-- by the anon role at the Postgres grant level.
--
-- Verified this was not an active hole: every one of these functions
-- checks auth.uid() and/or is_org_admin()/is_platform_owner() internally,
-- both of which correctly resolve to false/exception on a null uid (an
-- unauthenticated anon-key call), so an anonymous caller gets
-- 'not_authenticated' / 'not_authorized' either way. But least-privilege
-- grants matter independent of that backstop, so revoke the direct anon
-- grant explicitly (not "from public", which does not reach it).

revoke execute on function add_org_admin(uuid, uuid) from anon;
revoke execute on function archive_poll(uuid) from anon;
revoke execute on function bootstrap_platform_owner() from anon;
revoke execute on function close_poll(uuid) from anon;
revoke execute on function create_organization(text) from anon;
revoke execute on function duplicate_poll(uuid, text) from anon;
revoke execute on function generate_election_tokens(uuid, text[]) from anon;
revoke execute on function get_poll_admin_monitor(uuid) from anon;
revoke execute on function publish_poll(uuid) from anon;
revoke execute on function release_results(uuid) from anon;
revoke execute on function reopen_poll(uuid) from anon;
revoke execute on function set_final_option(uuid, uuid) from anon;

-- Also close the same gap for the two internal-only helpers, in case a
-- future migration recreates them and reintroduces a direct default-
-- privilege grant. Belt and suspenders: explicit revoke from every client
-- role, every time.
revoke execute on function log_audit(uuid, uuid, text, jsonb) from anon, authenticated;
revoke execute on function validate_answers(uuid, jsonb) from anon, authenticated;

-- Harden the default itself so future CREATE FUNCTION calls in this
-- schema stop auto-granting to anon/authenticated in the first place.
-- (This changes defaults for objects created by the 'postgres' role from
-- now on; it does not retroactively touch functions created by other
-- roles, which is why the explicit revokes above are still necessary.)
alter default privileges in schema public revoke execute on functions from anon, authenticated;
