/**
 * Import BEFORE ./env to point it at the seeded `local` branch instead of the
 * default `dev` branch. The analytics oracle test needs the seed; the Phase 3
 * integration tests need a branch they are free to wipe. Separate modules
 * because imports run in order and a plain assignment in the test file would
 * run after ./env had already loaded.
 */
process.env.ENV_FILE ??= ".env.development.local";
