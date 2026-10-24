# Desktop 84 / contrast 96 — fixes and limits (2026-10-24)

User's **production PSI**: desktop FCP 0.4s, LCP 0.4s, TBT 350ms,
CLS 0.05, performance 84, accessibility 96. Mobile at the same timestamp: 95.
The aggregate report does not identify the exact six long tasks or CLS sources.
No claim that a local task total is Lighthouse TBT; no claim of a new PSI score.

## Verified issue and fix: contrast

axe-core on the home page found one contrast violation at both 390px and 1350px:
`.hp-agent-badge`, green text #7ce386 on green #42c541, ratio **1.41:1**
(required 4.5:1). The late brand override conflicted with the badge's original
ink color. Restore #050505 on its existing green background. No global palette
change. After: **zero color-contrast violations** in four viewport/DPR checks.

## Layout stability

The hero title's max-width used `12ch` (mobile `13ch`). `ch` changes when the
font's zero-glyph metrics swap, changing the title width and wrapping. Use
`6.65em` / `7.2em`, approximating the loaded Cairo dimensions to within 1px,
and reserve a minimum of three 1.2em lines without clipping content. Preload
the Arabic 900 font on the home page (already required for the first title).

Artificially delaying heavy fonts by 1200ms reproduced a mobile shift of 0.026
before the fix. After: about 0.00001 mobile / 0.00007 desktop in that local
scenario. The reported desktop 0.05 was **not reproduced locally**, so these
numbers do not establish that all production CLS sources have been removed.

## Analytics scheduling — preserve measurement, don't remove tags

The public GTM container at the time of inspection has one Google tag,
G-CDT8Q9YSJ0, on initialization. The 139KiB unused-JS estimate is consistent
with analytics being a candidate, but the supplied report alone does not prove
how much of its 350ms TBT comes from analytics.

Both layouts now use `_includes/analytics.html` with the **same GTM container**:

- Create/preserve dataLayer and enqueue `gtm.start` immediately.
- Load or interaction schedules once; wait for the page's font readiness.
- Yield across a frame and task, then request background priority via postTask,
  falling back to idle callback or a zero-delay task in older browsers.
- Fetch the async GTM script with low fetch priority; remove interaction listeners.
- Font failure still schedules analytics. No fixed multi-second timer to hide work
  outside the audit, and no disabling pageviews or substituting IDs.
- Existing noscript fallback remains in both layouts.

**Limit:** GTM/GA still execute their own code on the main thread. This does not
remove their payload or guarantee a TBT below 200ms. Waiting for fonts may defer
the initial analytics request compared with the previous load-only scheduler;
queued events remain intact. Real GA delivery needs GTM Preview / production
inspection, not only a local mock response.

## Responsive supporting cards

Generate five 400px previews for the supporting home cards. `srcset` selects
400px at ordinary desktop density and keeps the existing 800px cards on 2x
mobile/desktop. The first home card shares the hero URL and reuses that image,
rather than downloading another preview.

The five files total **178,092 → 76,484 bytes** (101,608 bytes / ~99KiB smaller).
This is a file-size comparison, not a whole-page transfer measurement. Original
images are untouched. Missing manifest entries safely fall back to the old src.
Regenerate with `npm run images:home`; new listings do not break if not generated.

## Verification

- `npm test`: **439/439**, including seven new unit checks for scheduling, event
  preservation, duplicate-load protection, font failures, contrast, title sizing,
  previews, and noscript/container continuity.
- `css:check`, `fonts:check`, committed AI artifacts and audio gate: pass.
- Existing real-browser smoke suite: seven routes × mobile/desktop = 14 passes
  (font loading, no external fonts, rendering, reduced motion, print, JS errors).
- Extra checks: 390/1350 × DPR 1/2, scroll to all home sections, axe contrast,
  responsive-image source selection and no broken images/overflow.
- A mocked GTM script in the extra check executes once after fonts are loaded
  and sees the queued bootstrap. This is not a real-GA delivery test.
- Raw local evidence: `_diag/desktop-regressions-2026-10-24.json`.

Remaining PSI findings: Pages cache TTL headers and third-party JS payload are
not controlled by Jekyll CSS. No fake `_headers`, no disabling analytics, no
unverified CSP/HSTS changes. Re-run **production PSI on both form factors** after
publication; do not equate green CI checks with a 90+ performance score.
