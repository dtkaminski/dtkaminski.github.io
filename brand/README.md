# Greta logo (Route 3)

One master, rebuilt 11 Nov 2026 from the approved brand board
(`D2C Saas/Greta_Logo_Kit (3)/05_Brand_Reference/greta-approved-route-3-brand-board.png`).
The kit's own SVG files drew the mark as four thick arcs, and the app typed the wordmark in Arial.
Neither matched the board.

## The mark

Four equal discs in a pinwheel. Each disc sits under the next one round, in a cycle:
forest over purple, purple over stone, stone over terracotta, terracotta over forest.
So each lobe is its disc minus the disc above it, and a small square is left where all four meet.
That square is ink on every surface.

| | Value (board pixels) |
|---|---|
| Centre | 132.3, 177.3 |
| Disc radius | 40.5 |
| Centre to each disc | 35.3 |
| Turn | 8.75° clockwise (purple at the top) |

These were measured by fitting circles to the board, then checked by drawing the outlines over it.

Colours: `--color-brand-{forest,purple,terracotta,stone}` with a light end `-hi` for the kit's
top-left to bottom-right gradient. The centre square is `--color-brand-ink`.

## The wordmark

Outlined artwork, not live text: Inter Display (Inter 4 at opsz 32), weight 600, 107px on a
215 baseline, 1.5px tracking, the font's own kerning. Its letters match the board's to within a
few pixels. It follows `color`, so it turns off-white inside `.on-dark`.

## Files

| File | Use |
|---|---|
| `greta-logo.inline.svg` | The lockup every page draws inline. `{N}` becomes a per-copy id |
| `sync-logo.mjs` | Writes the lockup into the pages. Run `node brand/sync-logo.mjs` after changing it |
| `greta-logo-horizontal-light.svg`, `-dark.svg` | Standalone lockups with literal colours |
| `greta-mark.svg` | The mark alone |
| `greta-favicon.svg`, `../favicon.ico` | Browser tab icons |
| `greta-apple-touch-icon.png` | Home-screen icon, full bleed on off-white |
| `greta-mark-email.png` | The mark in the weekly email |

Size the logo with `--logo-height` (see `greta-logo.css`). The lockup is about 2.9 times as wide as
it is tall, and the wordmark's capitals are about half its height.
