-- Local Docker Compose only: a separate database for integration tests, which drop and recreate its schema.
CREATE DATABASE bulk_mailer_test OWNER bulk_mailer;
