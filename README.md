# Stockroom — inventory and stock tracker

180DC NITK Tech Team, Dev Task 1. Live at https://180dc-project.vercel.app.

The full README (setup, environment,
architecture, schema, AI tools, methodologies, demo credentials, live URL)
is written in Phase 7.

`DESIGN.md` documents the design decisions and the reasoning behind each one;
`BUILD_PROMPT.md` is the phased build — seven phases, each with the
verification that gated it.

## Design notes

### Reorder methodology

```
suggested reorder point = ceil(mean daily sales × L + k × σ × √L)
```

Mean and standard deviation σ of daily units sold over the trailing 30
complete days; L is the product's lead time in days. The buffer grows with √L
because demand over L days has L times the variance of one day's demand.
k = 1.65 is approximately a 95% service level (the one-sided 95% point of a
normal distribution) — approximately, because daily sales are neither normal
nor independent. Under 14 days on the shelf, counted from the first stock
movement, returns "insufficient history" rather than a number. Full reasoning
in `DESIGN.md` section 8.

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

### What CI does not cover

`src/lib/analytics.test.ts` runs with `npm test` locally but not in CI
(`.github/workflows/ci.yml`). It is a fixed-value oracle test: its expected
figures are hardcoded from one specific `npm run seed` run against the
hand-seeded Neon `local` branch, pinned to that seed's date. CI's database is
a fresh, empty `postgres:16` container every run, which can never have that
seed in it — and reseeding it in CI wouldn't help, since the seed always
covers "90 days ending yesterday" and can never again reproduce this test's
pinned date and figures. Every other test file runs in both places.

### Environment separation

Dev, local and production are Neon branches of the same project sharing one
role's password, so the hostname is the only thing separating them — not a
credential; separate roles per environment would be the production answer.
