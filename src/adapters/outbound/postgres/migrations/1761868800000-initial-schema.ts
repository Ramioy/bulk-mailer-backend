import type { MigrationInterface, QueryRunner } from 'typeorm';

const RECEIPT_STATES = `'PENDING','INVALID','SENDING','SENT','FAILED','UNCERTAIN','REMOVED'`;
const BLOCKS = `'CASH','AVVILLAS','BANCOLOMBIA','DAVIVIENDA','ANGLO','OTHERS'`;
const DELIVERY_STATES = `'UNCONFIRMED','SOFT_BOUNCE','ACCEPTED','HARD_BOUNCE','COMPLAINT'`;
const PERIOD = `CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`;

export class InitialSchema1761868800000 implements MigrationInterface {
  name = 'InitialSchema1761868800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE receipts (
        sha256                 char(64) PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        period                 char(7) NOT NULL ${PERIOD},
        block                  text NOT NULL CHECK (block IN (${BLOCKS})),
        state                  text NOT NULL CHECK (state IN (${RECEIPT_STATES})),
        file_name              text NOT NULL,
        concept_key            text,
        contract               text,
        size_bytes             integer NOT NULL CHECK (size_bytes >= 0),
        error_type             text,
        error_detail           text,
        recipient_email        text,
        recipient_complex_name text,
        file_available         boolean NOT NULL,
        attempts               integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        delivery_state         text CHECK (delivery_state IN (${DELIVERY_STATES})),
        created_at             timestamptz NOT NULL,
        updated_at             timestamptz NOT NULL,
        CHECK ((recipient_email IS NULL) = (recipient_complex_name IS NULL))
      );
      CREATE INDEX receipts_batch_idx ON receipts (period, block);
      CREATE INDEX receipts_state_idx ON receipts (state);

      CREATE TABLE receipt_history (
        seq     bigserial PRIMARY KEY,
        sha256  char(64) NOT NULL REFERENCES receipts (sha256),
        at      timestamptz NOT NULL,
        event   text NOT NULL,
        detail  text
      );
      CREATE INDEX receipt_history_sha256_idx ON receipt_history (sha256, seq);

      CREATE TABLE batches (
        period            char(7) NOT NULL ${PERIOD},
        block             text NOT NULL CHECK (block IN (${BLOCKS})),
        state             text NOT NULL CHECK (state IN ('OPEN','RUNNING','COMPLETED','STOPPED')),
        manifest_version  integer NOT NULL CHECK (manifest_version >= 0),
        stop_reason       text,
        updated_at        timestamptz NOT NULL,
        PRIMARY KEY (period, block)
      );

      CREATE TABLE manifests (
        period   char(7) NOT NULL,
        block    text NOT NULL,
        version  integer NOT NULL CHECK (version >= 1),
        entries  jsonb NOT NULL,
        PRIMARY KEY (period, block, version),
        FOREIGN KEY (period, block) REFERENCES batches (period, block)
      );

      CREATE TABLE executions (
        execution_id      text PRIMARY KEY,
        period            char(7) NOT NULL,
        block             text NOT NULL,
        manifest_version  integer NOT NULL,
        started_by        text NOT NULL,
        started_at        timestamptz NOT NULL,
        copy_address      text,
        finished_at       timestamptz,
        result            text CHECK (result IN ('COMPLETED','STOPPED')),
        stop_reason       text,
        CHECK ((finished_at IS NULL) = (result IS NULL))
      );
      -- Global lock: only one execution without finished_at in the whole system.
      CREATE UNIQUE INDEX executions_one_running_idx ON executions ((true)) WHERE finished_at IS NULL;

      CREATE TABLE attempts (
        attempt_id           text PRIMARY KEY,
        sha256               char(64) NOT NULL REFERENCES receipts (sha256),
        execution_id         text REFERENCES executions (execution_id),
        kind                 text NOT NULL CHECK (kind IN ('BATCH','RESEND')),
        to_address           text NOT NULL,
        copy_address         text,
        started_at           timestamptz NOT NULL,
        finished_at          timestamptz,
        outcome              text,
        detail               text,
        provider_request_id  text,
        email_reference      text
      );
      CREATE INDEX attempts_sha256_idx ON attempts (sha256, started_at);

      CREATE TABLE suppressions (
        email       text PRIMARY KEY,
        reason      text NOT NULL CHECK (reason IN ('HARD_BOUNCE','COMPLAINT')),
        since       timestamptz NOT NULL,
        attempt_id  text
      );

      CREATE TABLE delivery_events (
        event_id      text PRIMARY KEY,
        attempt_id    text NOT NULL,
        recipient     text NOT NULL,
        is_primary    boolean NOT NULL,
        state         text NOT NULL CHECK (state IN (${DELIVERY_STATES})),
        reason        text,
        occurred_at   timestamptz NOT NULL,
        seq           bigserial NOT NULL
      );
      CREATE INDEX delivery_events_attempt_idx ON delivery_events (attempt_id, seq);

      CREATE TABLE alerts (
        seq        bigserial PRIMARY KEY,
        alert_id   text NOT NULL UNIQUE,
        type       text NOT NULL,
        subject    text NOT NULL,
        detail     text NOT NULL,
        raised_at  timestamptz NOT NULL
      );

      CREATE TABLE audit_entries (
        seq             bigserial PRIMARY KEY,
        audit_id        text NOT NULL UNIQUE,
        actor           text NOT NULL,
        action          text NOT NULL,
        at              timestamptz NOT NULL,
        subject         text NOT NULL,
        previous_value  text,
        new_value       text,
        note            text
      );

      -- Append-only at storage level, whatever credentials are used (see also deploy/db/roles.sql).
      CREATE FUNCTION audit_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'AUDIT_IMMUTABLE: audit entries cannot be updated or deleted' USING ERRCODE = 'check_violation';
      END;
      $$;
      CREATE TRIGGER audit_entries_no_update_delete BEFORE UPDATE OR DELETE ON audit_entries
        FOR EACH ROW EXECUTE FUNCTION audit_entries_immutable();
      CREATE TRIGGER audit_entries_no_truncate BEFORE TRUNCATE ON audit_entries
        FOR EACH STATEMENT EXECUTE FUNCTION audit_entries_immutable();

      CREATE TABLE concepts (
        key      text PRIMARY KEY,
        subject  text NOT NULL,
        active   boolean NOT NULL
      );
      INSERT INTO concepts (key, subject, active) VALUES
        ('PAGO ADMINISTRACIÓN', 'Pago administración', true),
        ('CUOTA EXTRA', 'Cuota extra', true),
        ('MULTA', 'Multa', true);

      CREATE TABLE settings (
        id                    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        archive_copy_enabled  boolean NOT NULL DEFAULT false
      );
      INSERT INTO settings (id) VALUES (1);

      CREATE TABLE jobs (
        job_id      uuid PRIMARY KEY,
        seq         bigserial NOT NULL,
        type        text NOT NULL,
        payload     jsonb NOT NULL,
        run_at      timestamptz NOT NULL,
        status      text NOT NULL CHECK (status IN ('READY','CLAIMED','DONE','FAILED')),
        attempts    integer NOT NULL DEFAULT 0,
        error       text,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX jobs_ready_idx ON jobs (run_at, seq) WHERE status = 'READY';
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP TABLE jobs, settings, concepts, audit_entries, alerts, delivery_events, suppressions,
        attempts, executions, manifests, batches, receipt_history, receipts;
      DROP FUNCTION audit_entries_immutable();
    `);
  }
}
