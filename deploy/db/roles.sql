-- Run by the deployment team once per environment, after `pnpm db:migrate`, as the database owner.
-- The application connects as bulk_mailer_app, which can read and write every table except that
-- audit entries are insert-only. The migration also blocks UPDATE/DELETE/TRUNCATE on audit_entries
-- with a trigger, whatever role is used.
--
-- Replace the password with one generated for the environment and store it in the secrets manager.

CREATE ROLE bulk_mailer_app LOGIN PASSWORD :'app_password';

GRANT USAGE ON SCHEMA public TO bulk_mailer_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bulk_mailer_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bulk_mailer_app;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_entries FROM bulk_mailer_app;
REVOKE ALL ON migrations FROM bulk_mailer_app;
