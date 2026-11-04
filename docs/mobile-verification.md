# Native mobile verification — 2026-11-02

## Environment and coverage

Development builds ran on MacStudio, with an iPhone 17 Pro simulator (iOS 26.3)
and Medium Phone Android emulator (Android 16, API 36.1, arm64).
The Svelte web app ran in Chromium at 390 × 844. Expo web is not supported.
Screenshots below are real captures, scaled proportionally to 390 px width;
each image has **Web → iOS → Android** from left to right. Native safe areas,
platform text rendering and scroll positions account for some differences.

The isolated gateway used HTTP/1.1 Connect on 37444, an h2c BFF endpoint on 37446,
and its own temporary PostgreSQL. SSH reverse forwarding exposed 37444 on the Mac.
iOS used `http://127.0.0.1:37444`; Android used `http://10.0.2.2:37444`.
No live stack ports, Tailscale configuration or real model credentials were used.
The worker and bot model generated scripted responses, with delayed worker chunks.

| Manual flow | iOS | Android |
| --- | --- | --- |
| One-time code → paired overview | Passed | Passed |
| New thread delivered through live overview | Observed | Observed |
| Open thread, send, receive partial and completed answer | Passed | Passed |
| Relaunch preserves pairing in SecureStore | Passed | Passed |
| System light/dark | Passed | Passed |
| Accent change on iOS appears on Android | Passed | Passed |
| Bot conversation, send and live reply | Passed | Passed |
| Unpair → Pair screen, token revoked in gateway | Passed | Passed |

The thread details sheet and work fold were opened during review. Web Settings
→ Mobile devices → Pair a phone displayed a locally generated QR and short code.
For that throwaway dialog, the advertised HTTPS address was a placeholder;
devices used the explicit loopback addresses above. Camera scanning was not tested.
The [web pairing dialog](assets/mobile/pair-web.png) shows a disposable test code;
its gateway and database were removed after review.

## Screenshots

| Screen | Light | Dark |
| --- | --- | --- |
| Threads sidebar/list | [Compare](assets/mobile/threads-light.png) | [Compare](assets/mobile/threads-dark.png) |
| Thread timeline and composer | [Compare](assets/mobile/thread-light.png) | [Compare](assets/mobile/thread-dark.png) |
| Appearance settings | [Compare](assets/mobile/settings-light.png) | [Compare](assets/mobile/settings-dark.png) |
| Bot chat | [Compare](assets/mobile/bot-light.png) | [Compare](assets/mobile/bot-dark.png) |

Web uses a drawer for its phone sidebar; native uses a dedicated screen.
Thread controls retain web naming and icon paths; native details/actions use sheets.
Settings preserve the web navigation order, breadcrumb, schemes and accent choices.
Bot chat is an initial native implementation: message bubbles and mascots are shared
visually, while header actions and advanced editing remain narrower than web.

## Automated and build checks

- `bun install`, workspace `bun run typecheck` including mobile and shared UI,
  `bun run gen:check`, mobile lint, and the web production build passed.
- `bun run check:tmp`: **627 passed, 144 skipped, 0 failed** across 128 files;
  no test-owned temporary directories remained. Live provider tests were skipped.
- Gateway integration covers pairing expiry/revoke/reuse/concurrency, hashes and
  ownership, device/service authorization, stream revocation, self-unpair,
  administrative restrictions and exchange rate limiting.
- The app's pure TypeScript client calls GetOverview and receives WatchThread
  from a real HTTP/1.1 Connect listener under Bun.
- Expo Doctor: **20/20**. CNG generates both platforms; Hermes exports for both
  iOS and Android pass. Native Xcode and Gradle development builds were also built,
  installed and used for the manual flows above. No generated native trees are committed.

Local build logs and original captures are under `.tmp/mobile-verification/` (ignored).
The review used the `componentize` structure and a final inline code review of the
shared resources, session boundaries, reducers, composer delivery, markdown links,
settings writes, native configuration and incomplete screens. No UI tests were added.

## Remaining verification and limits

Physical camera/QR, a physical iPhone/Android phone, real model output, Tailscale HTTPS,
network loss and background/foreground recovery were not manually verified.
Retry/backoff and fresh stream snapshots are implemented. Thread questions/approvals
are read-only; bot cards support replies, but those cards had no pending fixture in
this device session. Goals, routines and advanced settings administration stay in web.
There are no attachments, push notifications or durable offline message storage.

Setup, exact device/build commands and SDK troubleshooting are in [mobile.md](mobile.md).
This historical device session predates pinned Network access; native pinning and pairing v2
still require iPhone/Android verification.
