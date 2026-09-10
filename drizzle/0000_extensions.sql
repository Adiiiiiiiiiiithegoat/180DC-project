-- DESIGN.md section 6. pg_trgm powers products_name_trgm_idx, which the
-- upload matcher in section 3 uses to score product-name similarity inside
-- Postgres rather than pulling the catalogue into Node. It has to exist before
-- the GIN index that references gin_trgm_ops, hence its own first migration.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
