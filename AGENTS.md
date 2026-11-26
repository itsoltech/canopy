# AGENTS.md

Short rules for agents working in this repository. Details live in `docs/` (most docs are in Polish).

## Project

- **Canopy**: an AI agent platform. Bun + TypeScript monorepo.
  - `apps/gateway`: gRPC gateway and the only Postgres client: owner-scoped API, worker command outbox, bot queue and tools, connector proxy, GitHub, agent bus. Server builds also serve the web app in-process. It never calls model APIs.
  - `apps/worker`: runs Claude Agent SDK, Codex app-server, and the Grok and Antigravity CLIs over ACP. Hidden bot sessions use Claude, Codex or Grok.
  - `apps/web`: SvelteKit BFF + SPA, embedded in the server gateway or the desktop controller.
  - `apps/desktop`: Electron + a Bun controller. Local mode supervises PostgreSQL, a gateway and a worker; remote mode runs only the local BFF against a paired gateway.
  - `apps/mobile`: Expo app over Connect with a pinned TLS certificate.
  - `packages/*`: contracts, db, domain, updater, …
  - `proto/canopy/*`: the gRPC contracts.
- The name is **Canopy** everywhere: code, docs, UI, prompts, env vars (`CANOPY_*`), packages (`@canopy/*`), proto (`canopy.*`). No traces of former names, no legacy fallbacks.
- UI and user-facing text are in English. Docs in `docs/` are in Polish (except `docs/copy.md`, which is in English); keep that when editing them.
- Don't name other products as inspiration in code, docs, tests or commits. Don't commit analysis, verification, spike or test-run artifacts (reports, screenshots, logs); keep only finished docs, and fold generic lessons into the relevant doc. Never put machine-specific paths, hosts or workarounds in the repo; keep those outside it.
- Start with `docs/architecture.md`. Then read the doc for the area you touch: `protocol.md`, `worker-config.md`, `bots.md`, `connectors.md`, `github.md`, `workspace.md`, `agent-visuals.md`, `desktop.md`, `mobile.md`, `linked-computers.md`, `network-access.md`, `updates.md`, `release.md`, `deploy.md`, `ui-api.md`.
- A PR that changes behaviour updates that area's doc in the same PR, including its status line. Keep implemented behaviour, plans and release availability (nightly/beta/stable) apart; don't leave a doc calling merged work a draft or plan.

## Branches, commits, releases

- Branches and channels:
  - `dev`: default branch, **nightly** channel.
  - `next`: **beta**.
  - `main`: **stable**.
- Branch off `dev` and open PRs into `dev`. Never push to `next`/`main`, never create tags; scheduled promotion/release workflows own these operations, with maintainer overrides via Promote.
- A `fix`/`perf`/revert correcting behaviour that an earlier merged change introduced must link it in the commit/PR body: `Fixes: #68` (original PR) or `Refs: <sha>`; reverts keep `This reverts commit <sha>`. Automatic promotion holds the linked change **and everything merged after it** until the fix has soaked, capped at one day for each channel from the held change's eligibility (details in `docs/release.md`), so:
  - link only the PR whose behaviour the fix actually corrects (the change that introduced the bug), not PRs that merely touched the same code or gave context;
  - don't link from `test`, `ci`, `docs`, `refactor` or `chore` commits, and don't link for pre-existing behaviour no recent change introduced;
  - for context-only mentions write `Related: #68` (not parsed, holds nothing).
  Changed-line blame is only a fallback for unlinked fixes.
- Merges are **squash merges**: one Angular commit per feature. The PR title becomes the commit.
- When you open a ready (non-draft) PR into `dev`, enable auto-merge right away (`gh pr merge <number> --auto --squash`): required CI checks still gate it. Never on drafts or stacked PRs; a stack merges at once (below).
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

- After any proto change run `bun run gen` and commit the generated code; CI verifies it with `bun run gen:check`.
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
- Add a test only for a distinct observable regression in these areas. Check existing coverage first and extend the closest test when it already crosses the right boundary. Changes to presentation, copy, wiring already covered at a real entry point, or a behavior-preserving refactor can often be verified without a new test.
- Make the expected result independent of the system under test. A test must fail for the regression it names. Keep the behavior being tested real, put fakes at its dependencies, and isolate a single reason for rejection. Avoid asserting fixture behavior, tautologies, and broad success or error checks that pass for the wrong reason.
- For async tests, wait for the event that makes the assertion valid at the component being checked. Check the result of polling, allow redelivery where the protocol permits it, and await outstanding work before releasing its resources. Use a controlled per-instance clock or timing configuration for retry, expiry and backoff. See [test design and async examples](docs/contributing.md#projektowanie-testów).
- Use the smallest fixture that crosses the actual boundary. Keep distinct behavior, OS and artifact contracts covered. Move repeated runs of the same scenario, long real-time waits used for soak, and benchmarks outside required CI. Use CI timings to choose what to shorten, including expensive setup, smoke checks, and artifact transfers.
- GitHub CI owns the full verification gate: frozen dependency install, `gen:check`, repository-wide typecheck, lint, formatting, tests through `check:tmp`, and builds selected by the workflow. Required CI checks must pass for the revision being merged; agents must inspect failures and fix those caused by their changes.
- Local verification is selective. Run a check only when it gives useful feedback on the changed behavior: affected test files, the affected package's typecheck, or lint on edited files. Choose the smallest useful scope; there is no mandatory local checklist before handoff or opening a PR.
- Do not routinely run `bun run check`, unrestricted `bun test` or `bun run check:tmp`, all test shards, repository-wide typecheck/lint/format checks, or web/release builds locally. Broaden a local check only to investigate a concrete failure that narrower checks cannot resolve, or when the user explicitly requests it. A large change alone is not a reason to duplicate CI.
- `check:tmp` runs tests, not just a cleanup check. To check affected tests and their cleanup, use `bun run check:tmp ./path/to/file.test.ts` from the repository root. Do not run the same tests once through `bun test` and again through `check:tmp` without a diagnostic reason.
- Install dependencies only when missing or when dependency manifests or the lockfile changed. Generate affected outputs when their sources change; leave the subsequent full `gen:check` to CI.
- Documentation-only changes need a diff and content/link review; do not install dependencies or run code checks, tests, or builds for them. Follow the CI workflow's existing selection of checks.
- Reuse successful local checks while their inputs remain unchanged. In the handoff/PR, state what ran locally and what is left to CI; do not claim pending CI passed. Domain docs listing the full gate describe CI requirements, not additional local checklists.
- Check changed layouts and interactions in a representative runtime. Use a real browser for the shared web/desktop renderer and a narrow viewport for affected responsive web layouts. Add themes, widths or input modes when the change can affect them differently.
- For shared code, follow its callers to identify affected behavior. Use a focused test or one representative runtime for shared paths. Add a native client or operating system check when it exercises a distinct affected path, such as Electron window behavior or mobile permissions.
- Run resource-intensive checks sequentially on shared workers and stop the processes you started when done. If a relevant runtime check is unavailable or the worker lacks resources, use the closest focused check available. You can open the PR with the unverified scenario recorded in its description.

## Code quality

- Lint is oxlint with the vendored anti-slop rules (`tools/oxlint/anti-slop`, `oxlint.config.ts`); formatting is oxfmt. CI enforces both. Details and rule notes: `docs/code-quality.md`.
- Format edited files supported by oxfmt with `bun run format -- <files>`; avoid formatting the whole repository. Markdown is ignored by oxfmt. Fix lint findings properly: parse data at boundaries instead of `typeof` checks and casts, use real types instead of `unknown`, keep assertions only with a `// SAFETY:` comment that states the invariant.
- Size limits: 400 code lines per file and 120 per function (tests: 800 per file). Split by responsibility; never disable the size rules.
- `oxlint-disable-next-line <rule> -- <reason>` only when the fix would be wrong, with a precise reason.
- Never run plain `oxlint --fix` on the whole repo; use `bun run lint:spacing` for the spacing autofix.

## UI rules

- For UI audits and cleanup, including `$unslop-ui`, apply the [Canopy UI review rules](docs/ui-review.md). Keep cues that help people find a destination, distinguish states or choose an action. The Settings sidebar pairs section icons with text so people can scan it. A repeated cue or a counter hit alone does not justify removing it.
- Use the type and density scale in `docs/ui-scale.md`; overlays (popovers, menus, pickers) are compact.
- Controls that appear on state changes (reset buttons, inline actions, badges) must not move existing elements: place them on the side away from the alignment edge or reserve their space.
- Custom form controls only: no native `select`, radio, range or color inputs. Use the kit in `apps/web/src/lib/shared/ui`.
- Tailwind v4 pitfall: kit components carry their own positioning/padding classes, which beat conflicting classes you pass via `class`. Wrap the component in an element instead.
- Motion follows the tokens in `motion.ts` / `motion.css` and respects `prefers-reduced-motion`.
- Don't center with `-translate-*` on elements that also use a `rise`/`swap` transition: they animate `translate`. Use flex instead.
- Keep components small and reusable; extract repeated UI.
- Check truncation and wrapping with short, typical and long names, branches or labels where their length can affect the changed layout. Use the `design`, `componentize` and `transitions-dev` skills for UI work.
- Check overlays, sticky headers and scroll areas for gaps and see-through seams (stray padding, margins or offsets).
- UI text follows `docs/copy.md`. Run its copy audit (§8) for every feature that changes UI text, fix every failed item before opening the PR and put the result in the PR description; an item left failing needs its reason in the PR. No separate copy review is needed.

## Security

- Never commit secrets: API keys, tokens, worker credentials, private hosts.
- Platform credentials are stored only in the gateway, encrypted, and are never sent to browsers, models or logs. They leave the gateway only as follows:
  - connector and GitHub tokens never leave the gateway; workers and bots get proxied access only;
  - provider proxy/API keys reach a worker only in `WorkerConfig` over the authenticated link, kept in worker memory and the harness process env, never in reports, logs or config files;
  - thread secrets (`request_secret`) reach only the asking thread's worker as an expiring private file; the model gets the path, never the value.
- Agent CLI logins live on the worker machine and never go to the gateway.
- Every gateway action is owner-scoped. Approvals and grants are enforced in the gateway, not the UI.
- Never print or log secret values in tools, tests or CI.

## Local environment etiquette

- The maintainer may run a live stack on this machine: ports 17443, 5180, 8444, 17444, 17445. Do not use or stop those.
- Run your own servers on other ports.
- Never kill processes by command pattern (`pkill -f …`). Stop only what you started, by PID or port.
- Tailscale: never touch existing `serve` ports and never enable Funnel.
