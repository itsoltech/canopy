# AGENTS.md

Short rules for agents working in this repository. Details live in `docs/` (most docs are in Polish).

## Project

- **Canopy**: an AI agent platform. Bun + TypeScript monorepo.
  - `apps/gateway`: gRPC gateway, Postgres; bots run here.
  - `apps/worker`: runs Claude Agent SDK, Codex app-server and the Grok CLI over ACP.
  - `apps/web`: SvelteKit BFF + SPA.
  - `apps/desktop`: Electron.
  - `apps/mobile`.
  - `packages/*`: contracts, db, domain, updater, …
  - `proto/canopy/*`: the gRPC contracts.
- The name is **Canopy** everywhere: code, docs, UI, prompts, env vars (`CANOPY_*`), packages (`@canopy/*`), proto (`canopy.*`). No traces of former names, no legacy fallbacks.
- UI and user-facing text are in English. Docs in `docs/` are in Polish; keep that when editing them.
- Start with `docs/architecture.md`. Then read the doc for the area you touch: `protocol.md`, `worker-config.md`, `bots.md`, `connectors.md`, `updates.md`, `release.md`, `deploy.md`, `ui-api.md`.

## Branches, commits, releases

- Branches and channels:
  - `dev`: default branch, **nightly** channel.
  - `next`: **beta**.
  - `main`: **stable**.
- Branch off `dev` and open PRs into `dev`. Never push to `next`/`main`, never create tags; scheduled promotion/release workflows own these operations, with maintainer overrides via Promote.
- A `fix`/`perf`/revert correcting behaviour that an earlier merged change introduced must link it in the commit/PR body: `Fixes: #68` (original PR) or `Refs: <sha>`; reverts keep `This reverts commit <sha>`. Automatic promotion holds the linked change **and everything merged after it** until the fix has soaked (24 h), so:
  - link only the PR whose behaviour the fix actually corrects (the change that introduced the bug), not PRs that merely touched the same code or gave context;
  - don't link from `test`, `ci`, `docs`, `refactor` or `chore` commits, and don't link for pre-existing behaviour no recent change introduced;
  - for context-only mentions write `Related: #68` (not parsed, holds nothing).
  Changed-line blame is only a fallback for unlinked fixes.
- Merges are **squash merges**: one Angular commit per feature. The PR title becomes the commit.
- `dev` only gets complete, working features: it feeds beta and stable. A plan with several stages ships as **stacked PRs** (`gh stack`, extension `github/gh-stack`):
  - each stage is its own PR, based on the previous stage's branch; the bottom one targets `dev`,
  - keep them drafts until the whole plan is done and verified,
  - then merge the stack at once (`gh stack merge <stack> --squash`), never stage by stage.
- **Angular commit convention**, enforced by commitlint (a commit-msg hook installed by `bun install`, plus a CI check of PR titles):
  - Format: `type(scope): summary`, lower case, header ≤ 72 chars, no trailing period.
  - `feat` → minor release; `fix`/`perf` → patch.
  - `docs`, `refactor`, `test`, `ci`, `build`, `chore`, `style` → no release.
  - Avoid `BREAKING CHANGE` footers before 1.0 unless agreed.
- semantic-release computes versions. All apps share one version (`CANOPY_VERSION`, `scripts/version.ts`). Release notes live in GitHub Releases; there is no CHANGELOG file.

## Contracts and database

- After any proto change run `bun run gen` and commit the generated code; `bun run gen:check` must be clean.
- Proto changes are **additive only**: new fields get new numbers, never reuse or renumber.
- `proto/canopy/update/v1` is **frozen forever**: it must work across every pair of versions.
- Worker↔gateway compatibility goes through `WORKER_LINK_PROTOCOL` in `packages/domain/src/release/protocol.ts`.
- Migrations live in `packages/db/src/migrations/NNNN_name.sql`. Rules:
  - Never edit an applied migration.
  - New = highest number + 1. The migrator only applies numbers above the last applied one, so if another branch landed first, **renumber yours**.
  - Update the expected list in `packages/db/test/schema.test.ts`.

## Testing policy

- Only meaningful tests:
  - gateway↔worker gRPC integration,
  - durability and restarts,
  - migrations,
  - security and owner scoping,
  - harness adapters,
  - opt-in live tests (`CANOPY_LIVE=1`, run from the repo root so the bun preload applies).
- **No web UI tests** (no component tests, no Playwright suites) and no trivial unit tests.
- Before handing over, all of these must be clean:
  - `bun install`
  - `bun run gen:check`
  - `bun run typecheck`
  - `bun run lint` and `bun run format:check`
  - `bun run check:tmp` (full test run that also checks nothing is left in the temp dir)
  - the web build
- Look at UI changes yourself in a real browser: light + dark, desktop + phone width.

## Code quality

- Lint is oxlint with the vendored anti-slop rules (`tools/oxlint/anti-slop`, `oxlint.config.ts`); formatting is oxfmt. CI enforces both. Details and rule notes: `docs/code-quality.md`.
- Run `bun run format` after editing. Fix lint findings properly: parse data at boundaries instead of `typeof` checks and casts, use real types instead of `unknown`, keep assertions only with a `// SAFETY:` comment that states the invariant.
- Size limits: 400 code lines per file and 120 per function (tests: 800 per file). Split by responsibility; never disable the size rules.
- `oxlint-disable-next-line <rule> -- <reason>` only when the fix would be wrong, with a precise reason.
- Never run plain `oxlint --fix` on the whole repo; use `bun run lint:spacing` for the spacing autofix.

## UI rules

- Custom form controls only: no native `select`, radio, range or color inputs. Use the kit in `apps/web/src/lib/shared/ui`.
- Tailwind v4 pitfall: kit components carry their own positioning/padding classes, which beat conflicting classes you pass via `class`. Wrap the component in an element instead.
- Motion follows the tokens in `motion.ts` / `motion.css` and respects `prefers-reduced-motion`.
- Don't center with `-translate-*` on elements that also use a `rise`/`swap` transition: they animate `translate`. Use flex instead.
- Keep components small and reusable; extract repeated UI.
- Check UI with short, typical and long/worst-case texts (names, branches, labels) at desktop, narrow and phone widths, where it matters; truncation and wrapping must stay tidy. Use the `design`, `componentize` and `transitions-dev` skills for UI work.
- Check overlays, sticky headers and scroll areas for gaps and see-through seams (stray padding, margins or offsets).

## Security

- Never commit secrets: API keys, tokens, worker credentials, private hosts.
- Credentials stay in the gateway, encrypted. They never go to workers, browsers, models or logs.
- Every gateway action is owner-scoped. Approvals and grants are enforced in the gateway, not the UI.
- Never print or log secret values in tools, tests or CI.

## Local environment etiquette

- The maintainer may run a live stack on this machine: ports 17443, 5180, 8444, 17444, 17445. Do not use or stop those.
- Run your own servers on other ports.
- Never kill processes by command pattern (`pkill -f …`). Stop only what you started, by PID or port.
- Tailscale: never touch existing `serve` ports and never enable Funnel.
