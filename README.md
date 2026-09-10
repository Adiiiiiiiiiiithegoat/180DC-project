# Stockroom — inventory and stock tracker

180DC NITK Tech Team, Dev Task 1. The full README (setup, environment,
architecture, schema, AI tools, methodologies, demo credentials, live URL)
is written in Phase 7; `DESIGN.md` is the reference until then.

## Design notes

### A product with sales history cannot be deleted

`sale_lines.product_id` and `receipt_lines.product_id` reference `products(id)`
with no `ON DELETE CASCADE`, so Postgres refuses to delete a product that has
ever been sold or received. This is deliberate, and it is the append-only
principle rather than a limitation: deleting the product would orphan the
ledger — sale lines and receipt lines pointing at nothing, historical revenue
and margin with no product behind them. A product that is no longer sold is
deactivated (`is_active = false`) instead: hidden from the sale screen, kept
for history.

The same rule reaches accounts. `users` cascades to everything it owns, but a
user who has traded owns products that the ledger still references, so the
account cannot be deleted out from under its own history either. For the same
reason the seed never deletes a demo account; `npm run seed` rebuilds the
database from migrations instead.
