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

UI tests are not kept in the repository; the rail is checked in a browser while working on it.

The `componentize` pass keeps the rail interaction, preview content and pure model in separate files,
reuses `Popover`/`MarkdownSnippet`, and preserves Svelte's class merging at each component boundary.
Motion follows the existing tokens and the tooltip travel recipe from `transitions-dev`.

## Verified result (2026-11-02)

Latest merged `main`: `0c535d4`. `bun install` completed without dependency changes.
The final `componentize`/self-review pass confirmed the three-file boundary, class merging,
kit-owned positioning/padding, keyboard descriptions, gesture cancellation and reduced motion.

| Check | Observed result |
| --- | --- |
| Repository typecheck | All workspaces passed; Svelte: 0 errors, 0 warnings. |
| Web build | Passed; the existing warning about chunks over 500kB remains. |
| Full `bun run check:tmp` after the timeline-folding merge | 841 passed, 161 skipped, 0 failed; nothing left in its private temp directory. |
| `bun run check:tmp apps/web` after the latest `main` merge | 308 passed, 0 failed; nothing left in its private temp directory. |
| Chromium acceptance on the final build | 6 passed, 81 assertions, 0 browser exceptions; input alignment drift at most 0.296875px (limit 2px). |

Snapshots: `artifacts/turn-rail/1440-{light,dark}-preview.png`,
`1440-{light,dark}-last-aligned.png`, `1440-{light,dark}-compressed.png`,
`390-{light,dark}.png`, and `1440-reduced-motion.png`. Phone snapshots wait for the actual input row
and finish finite entrance animations before capturing. Browser/build/test logs live beside them.

Implementation commits (excluding merges from `main`):

| Commit | Scope |
| --- | --- |
| `2283d96` | Turn index, visible-range API, measured/estimated virtual-row navigation, initial unit tests. |
| `5362f42` | Rail, moving Markdown preview, keyboard access and motion. |
| `571826b`, `c17e09e` | Private long-thread browser stack and loaded phone screenshots. |
| `b21938f`, `0aed3b4` | Streaming jump lifetime, accessible descriptions, answer slots and original user message previews. |
| `0f47ea3` | Isolated immutable assets for Docker host network changes; final screenshot capture. |

The timeline-folding conflict was resolved in `10aa4ec`, retaining its completion-only
`scrollRowToTop` behavior and sharing reader gesture cancellation with rail navigation.
