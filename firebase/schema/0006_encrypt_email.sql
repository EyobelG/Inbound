-- ============================================================================
-- Inbound :: 0006_encrypt_email.sql
-- Documents that app_users.email is now application-level ciphertext, not
-- plaintext.
--
-- No column type or width change: AES-256-GCM ciphertext (IV + auth tag +
-- ciphertext, base64-encoded - see src/lib/crypto/piiCipher.ts) is still a
-- `text` value and Postgres text has no length constraint. Encryption and
-- decryption happen in application code (ensureAppUser / getUserEmail in
-- src/lib/auth.ts), not in SQL - pgcrypto was deliberately not used, so the
-- key never has to be handed to Postgres and this stays portable across
-- providers without a database-level KMS integration.
--
-- No backfill: at the time this shipped, no sign-in UI existed and no
-- verified Firebase ID token could be minted, so app_users held no rows with
-- real plaintext email addresses to migrate (see the RLS gap note in
-- CLAUDE.md for the same "unexploitable today" reasoning). If that stops
-- being true before this runs, backfill first: `select firebase_uid, email
-- from app_users where email is not null`, encrypt each with piiCipher, then
-- apply. A row already holding ciphertext survives this migration untouched.
-- ============================================================================

comment on column app_users.email is
  'AES-256-GCM ciphertext (base64: iv + authTag + ciphertext). Encrypted and decrypted only via src/lib/crypto/piiCipher.ts - never write or read this column with a plaintext value.';
