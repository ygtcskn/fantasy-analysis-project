# Distribution panel (`features/statistics/distribution.js`)

The **Dağılım · Emsallere Göre** panel at the bottom of the player profile on
İstatistikler (`index.html?view=statistics`): for the selected player, one row
per metric of his Ayrıntılı Ölçütler wheel - sixteen for outfielders, ten for
goalkeepers.

| File | Role |
| --- | --- |
| `distribution.js` | `PlayerDistribution` (pure: quantiles, bandwidth, density, the SVG) and `renderPlayerDistribution` (page wiring). |
| `distribution.css` | The panel and the percentile colours, with light and dark values. |

`src/web/index.html` loads them as `features/statistics/...`; `src/web/serve.py`
serves the whole website folder by file suffix. Restart it once after installing.

## Reading a row

- **The curve** is how the comparison players are spread on that metric: a
  Gaussian kernel density over their per-90 figures (or percentages), scaled to
  the row's own peak and drawn between the lowest and highest value, which are
  printed under the ends.
- **The dashed line and triangle** mark the selected player's value.
- **The coloured part** covers the peers he outperforms: from the left edge to
  his value, or - where a lower figure is better, such as goals conceded - from
  his value to the right edge. Its colour at each position is the percentile
  that position represents, with the colour stops at the peers' own quartiles.
  Beyond it the curve is grey.
- **On the right**, his value with its unit and his percentile, with a swatch in
  the percentile's colour.

The colours run from the site's amber (low) through a neutral to its radar
indigo (high). They follow light and dark mode, and unlike a red-to-green scale
they stay distinguishable for the common forms of colour blindness.

## Same numbers as the wheel

The chart is drawn from the reference `renderStatisticsRadars` in
`src/web/features/statistics/radar-page.js` has just built and returns: the same peers (this
season plus earlier Süper Lig seasons, same role and minute bar), the same
per-90 values, and the same percentile - mid-rank, with the zero-heavy rule,
shown 1-99 - so every number on the right equals the matching axis of
Ayrıntılı Ölçütler. See [src/web/lib/radar.md](../../lib/radar.md) for how
that reference and score are defined.

On a zero-heavy axis the percentile ranks a positive value among the players
who recorded the event at all, while the curve shows everyone, zeros included;
the two can therefore look different at the low end, and the tooltip gives the
number of peer values behind each row.

## Density

The bandwidth is Silverman's rule with the robust spread,
`0.9 × min(sd, IQR / 1.34) × n^-0.2`, so a heap of zeros does not shrink a
curve to a spike; when the interquartile range is zero it uses the standard
deviation, and a list with no spread at all falls back to a tenth of its range.
A metric with fewer than two peer values says so instead of drawing a curve.

## Tests

`tests/test_distribution.cjs` uses only synthetic data and Node's built-in
test runner. Run it yourself when desired:

```powershell
node --test tests/test_distribution.cjs
```

These checks were written but not run, following `AGENTS.md`.
