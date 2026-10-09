-- Fixture for tests/live/setup.live.test.ts: the tables the schema template
-- maps (see src/setup/template.ts). Load into a PostgreSQL database, schema
-- public, that PuppyGraph can reach.
DROP TABLE IF EXISTS account_devices, accounts, devices;
CREATE TABLE accounts (account_id BIGINT PRIMARY KEY, name TEXT);
CREATE TABLE devices (device_id BIGINT PRIMARY KEY);
CREATE TABLE account_devices (
  id BIGINT PRIMARY KEY,
  account_id BIGINT,
  device_id BIGINT,
  first_seen TIMESTAMP
);
INSERT INTO accounts VALUES (1, 'alice'), (2, 'bob'), (3, 'carol');
INSERT INTO devices VALUES (10), (20);
INSERT INTO account_devices VALUES
  (100, 1, 10, '2026-01-01 10:00:00'),
  (101, 2, 10, '2026-01-02 11:00:00'),
  (102, 3, 20, '2026-01-03 12:00:00');
