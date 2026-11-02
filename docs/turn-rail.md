# Conversation turn rail

The thread timeline has a quiet navigation rail in its left gutter once at least three turns are shown.
The rail reserves 36px beside the feed and never covers a message. Below 768px it is hidden, including
the 390px phone layout: the conversation keeps its full width and scrolling gestures stay available.
Expanded inherited history participates; collapsed history and queued/withdrawn turns do not.

Each turn has a short tick. Visible turns have longer, darker ticks; the running turn pulses gently.
Ticks are evenly spaced, at most 10px apart, and visually merge when less than 4px per tick is available.
The rail itself never scrolls. Merging preserves every turn's button and keyboard access.

Hover opens a preview with the user's message, the beginning of the final answer (or live commentary),
and the turn's timestamp. Both message previews use `MarkdownSnippet`. One `Popover` moves between
turns without reopening; first hover waits 500ms, closing waits 200ms, and reopening within 400ms is warm.
The surface uses the kit's own positioning and a padded content wrapper. Focus opens the same preview.
Up/Down or Left/Right move between turns, Home/End reach the first/last, Enter/Space jump, and Escape
closes the preview. There is one tab stop; buttons expose the turn number, message, current location,
and the open preview as their description.

## Feed integration

`rail/turn-rail.ts` derives turn headers, input row indices and previews from the existing `FeedRow[]`.
Opening work/history folds rebuilds those indices. Current-turn lookup uses binary search on the
**actual** visible range, excluding overscan and the sticky composer. No rail code reads message DOM
rectangles on scroll. `VirtualFeed` publishes `onviewport(FeedViewport)` at most once per animation frame.
Its `rowOffset(index)` reads the existing measured/estimated size index.

`scrollToRow(index, { align: "start", smooth: true })` starts at the estimated offset, mounts the target,
then corrects its position using the existing measured-row anchor. Extra trailing space permits even
the last input to reach the top. "Jump to latest" releases that space and follows the end again.
Reader gestures and another reveal/latest action cancel the pending jump correction. The timeline's
`scrollRowToTop(key)` remains its separate, mounted-answer-only completion behavior: it deliberately
does nothing for an unmounted row or someone reading above the end, so it cannot implement rail jumps.
Reduced motion disables smooth scrolling, tick transitions, card travel and the working pulse.

## Verification

```sh
bun install
bun test apps/web/test/turn-rail.test.ts apps/web/test/worked-for.test.ts apps/web/src/lib/shared/ui/virtual/size-index.test.ts
bun run typecheck
bun run check:tmp
bun run --filter @open-agents/web build
OA_TURN_RAIL_BROWSER=1 bun test tests/integration/turn-rail.browser.test.ts
```

The opt-in browser suite uses `/usr/bin/chromium`, a private throwaway PostgreSQL/gateway/scripted
worker, and the built web app at `127.0.0.1:5299`. It creates 120 completed turns plus one running turn,
then checks visible-range tracking, Markdown previews, warm movement, far virtualized jumps, keyboard
navigation, first/last input alignment within 2px (also after measurements settle), compression,
"Jump to latest", light/dark at 1440px, hidden phone rail at 390px, short threads and reduced motion.
The suite closes its own browser/processes/container. It does not use `/tmp/oa-stack` or ports
17443, 5180 or 8444. Screenshots are written to `artifacts/turn-rail/` (ignored by Git).
Immutable JS/CSS files are fulfilled from the actual web build by Playwright. This avoids Chromium's
`ERR_NETWORK_CHANGED` module-load failures when concurrent Docker test stacks change host interfaces;
HTML, API and SSE still use the live private stack. Static HTTP serving is outside this UI suite.

The unit suite covers compression up to 10,000 turns, visible-range boundaries, fold index changes,
final/live answer slots, rich input without provider platform notes, missing input and queued/withdrawn turns. Browser coverage is Chromium;
Safari/Firefox and a physical screen reader are outside this task's verification.

The `componentize` pass keeps the rail interaction, preview content and pure model in separate files,
reuses `Popover`/`MarkdownSnippet`, and preserves Svelte's class merging at each component boundary.
Motion follows the existing tokens and the tooltip travel recipe from `transitions-dev`.
