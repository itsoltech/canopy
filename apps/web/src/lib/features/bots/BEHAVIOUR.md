# Living mascots

`MascotFace` owns the SVG drawing for both explicit appearances and legacy hashed avatars.
`BotAvatar`, stacks, pinned tiles, message rows, shape choices and the wizard all use it.
Existing required props are unchanged, including the saved `participant.shape` / `participant.color`
from bots-core. Images and user initials have no behaviour.

## Optional controls

- `alive={false}` opts an individual mascot out. Actual rendered sizes below 24 px are static;
  `BotAvatar` also opts its 20 px `xs` size out explicitly.
- `state` accepts `idle`, `working`, `typing`, `waiting`, `done`, `error`. Working eyes read down-left;
  waiting eyes look toward the chat's composer. Hover temporarily takes precedence.
- Change `event` on a sent/received message for a small squash. Initial mounting is quiet.
  Change `reaction` on `MascotFace` for a name/hover lift. With `playful`, events become a wobble;
  the wizard's preview button supports pointer, touch, Enter and Space.
- `blink` remains accepted on `MascotFace` for source compatibility; the shared random scheduler now
  controls all natural blinking. No independent CSS blink loops remain.
- `ChatView` accepts optional `botActivity` entries (`botId`, `state`, optional `label`) for explicit
  per-bot activity rows. Existing `statusLine` callers already drive the header's expression:
  “Typing…” → typing, “Waiting…” → waiting, other tool phrases → working. Questions and the latest
  bot reply provide waiting/done states when no status is present. No gateway contract changed.

## Motion and restraint

`behaviour.ts` is a Svelte action backed by one shared pointer listener, one IntersectionObserver,
one ResizeObserver and one rAF scheduler. Each frame writes only SVG group `transform` attributes;
it never changes Svelte state. Geometry is cached and read in a batch after scroll, resize or
intersection changes. The scheduler cancels on a hidden tab or reduced motion, resets the drawing,
and disposes its global listeners when the last mascot unmounts. Off-screen and disabled mascots
receive no animation writes. The hidden-tab browser scenario uses a deterministic visibility fixture.

Breathing is ±0.6% on a six-second cycle, with independent phases. Blinks are independently sampled
at 3.6–8.2 seconds. Small idle glances occur at 12–24 second intervals after at least five seconds
without pointer motion. Touch taps and focus give a one-second glance, then return to idle.
Eye offsets use an elliptical clamp, with tighter envelopes for spark, star, diamond and triangle;
legacy pupils keep extra space inside their sclera. One screen-wide owner admits attention cues
(hop, lift, squash, wobble, happy squint, error shake); overlapping cues are dropped rather than queued.
State changes cause one cue, never a repeating attention loop. Durations read existing motion tokens.

Settings → Appearance → **Animated mascots** defaults on and is saved locally on this device,
with live updates in other tabs. `prefers-reduced-motion: reduce` always wins and disables all
mascot motion, including blinks. Turning either switch off restores neutral SVG transforms immediately.

## Verification

```sh
bun install
bun test apps/web/src/lib/features/bots/behaviour-math.test.ts apps/web/src/lib/features/bots/mascot.test.ts
CANOPY_MASCOTS_BROWSER=1 bun test apps/web/src/lib/features/bots/gallery/behaviour.browser.test.ts
bun run typecheck
bun run check:tmp
bun run --filter @canopy/web build
```

The opt-in browser suite owns Vite on **5196**, uses `/usr/bin/chromium` and Playwright from
`tests/integration`, and stubs only the shell transport. It checks actual `/dev/bots` components:
pointer following in light/dark, 50 visible mascots, frame intervals and Performance API long tasks,
static tiny/disabled avatars, expression direction, single attention ownership, off-screen suspension,
visibility lifecycle, reduced motion at boot and live, preference persistence, touch and wizard play.
It saves PNG frames, performance JSON and local logs under `.tmp/living-mascots/` (ignored by git).
No production stack, database or real model endpoint is needed for this browser suite.

The componentize pass keeps drawing and behaviour shared, extracts the gallery and settings row,
and reuses the app's existing `Switch`, `Select`, `Button` and `SettingsRow` components. Call sites own
spacing; new components accept `class`. The wizard retains the existing token-based crossfade.

Acceptance on 2026-11-02: focused Chromium suite **5 passed**, all 50 mascots active, light/dark
frame P95 **16.8 / 16.7 ms**, mean **16.67 ms**, **zero long tasks** in either 180-frame sample.
The full `check:tmp` run passed **913** tests (184 opt-in skips) and left no test temp entries.
After incorporating main through `8eb4f05`, the web checks passed **334** tests (7 opt-in skips)
with clean temp storage; workspace typecheck had zero errors/warnings and the web build succeeded.
These are local Chromium measurements with mocked shell transport, not a live-provider load test.
