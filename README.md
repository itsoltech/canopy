# Canopy

Canopy is a self-hosted platform for running AI coding agents and assistant bots across several machines from one place. A central **gateway** keeps state in PostgreSQL and orchestrates the work. **Workers** run on the machines where your code lives and drive the Claude Agent SDK, Codex and Grok. You follow and steer everything from the web app, the desktop app or your phone.

## Why Canopy

Most agent tools run in one terminal on one machine. That stops working once your work spans several machines, several model providers or more than one session:

- an agent is tied to the machine and terminal that started it, and you lose its context when you switch devices;
- you can only approve an action or answer an agent's question while you sit at that machine;
- you set up API keys, CLI logins and integrations again on every machine;
- mixing providers (say, planning with one model and implementing with another) means copying and pasting by hand;
- long-running work does not survive restarts or dropped connections.

Canopy puts one gateway in front of all of this. Work is durable and visible from every client, and agents can delegate to each other whatever their provider or machine.

## Key features

- **Threads on any worker.** Start an agent in a project directory on any connected machine. Send follow-ups as a queue or steer the running turn, fork from any finished turn, archive and rename threads, and let a model generate their titles.
- **Three agent harnesses.** Claude (Claude Agent SDK), Codex (`codex app-server`) and Grok (`grok` CLI over the Agent Client Protocol). Each one can use the CLI's own login or an API-compatible endpoint. You configure it once as a provider instance and assign it to selected workers.
- **Agent-to-agent orchestration.** Agents can spawn side threads (on another provider too), message other threads, get a report when a thread they follow finishes, and ask their parent instead of the user. The timeline shows who sent each message and how many agent-to-agent hops a chain has taken.
- **Approvals and questions.** Set a permission mode per thread (ask, read only, accept edits, full auto). Permission requests and structured `ask_user` questions survive restarts, and you can answer them from any client.
- **Goals, schedules and background work.** Harness goals are tracked in the UI. Schedules can be one-off or recurring, run into an existing thread or a new one, and either target a specific worker or let Canopy spread runs across workers (least busy or round robin). You can watch and stop background processes.
- **Secrets in threads.** An agent can ask for a secret. You enter it in a dedicated card, the gateway stores it encrypted, and the worker gets it as a private file with an expiry.
- **Bots.** Conversational assistants that live in the gateway and call model APIs directly. They have a durable tool loop and about fifty platform tools (projects, threads, schedules, settings, other bots). Bots support approval policies (ask for sensitive actions, ask for everything, full auto), routines (recurring background runs that only message you when something matters), reminders, bot-to-bot conversations, creating other bots, and a silent handoff note when their provider or model changes.
- **Connectors.** Connect external services (GitHub, Slack, Notion, Linear, Atlassian, Microsoft 365, or any remote MCP server) once in the gateway, with several named accounts per service. You grant each account to selected workers and bots. Tokens never leave the gateway, and calls are audited.
- **Worker management.** Add a machine from the UI with a one-time enrollment token, see its agent CLIs and versions, rename it, rotate or revoke its credential, or archive it.
- **Clients.** A web app, a desktop app that can run the whole stack locally, and an iOS/Android app paired with the gateway.

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    Browser["Browser"]
    Desktop["Desktop app<br/>(Electron)"]
    Mobile["Mobile app<br/>(iOS / Android)"]
  end

  Web["Web BFF<br/>(SvelteKit)"]

  subgraph GW["Gateway"]
    Core["Orchestration<br/>threads · agent bus · schedules"]
    Bots["Bots runtime"]
    Conn["Connectors<br/>(MCP proxy)"]
  end

  DB[("PostgreSQL")]

  subgraph W1["Worker (machine A)"]
    C1["Claude Agent SDK"]
    X1["Codex app-server"]
    G1["Grok CLI (ACP)"]
  end
  subgraph W2["Worker (machine B)"]
    C2["Claude / Codex / Grok"]
  end

  Ext["Model APIs and<br/>external services"]

  Browser -- "HTTP + SSE" --> Web
  Desktop -- "loads the web app" --> Web
  Web -- "gRPC / Connect<br/>service token" --> GW
  Mobile -- "Connect (HTTP/1.1)<br/>device token" --> GW
  GW --- DB
  W1 -- "gRPC bidirectional stream<br/>(worker dials out)" --> GW
  W2 -- "gRPC bidirectional stream" --> GW
  Bots --> Ext
  Conn --> Ext
```

- **Gateway** — the single entry point for clients. It stores everything in PostgreSQL, routes commands to workers, runs bots and the connector proxy, and encrypts secrets with a key from its environment.
- **Workers** — each opens a long-lived bidirectional gRPC stream to the gateway (no inbound ports needed). The gateway sends commands (start, steer or interrupt a turn, apply configuration, answer a permission request); the worker streams back items, turn state, interaction requests, model catalogs and platform tool calls. A local journal with acknowledged cursors makes sure no events are lost across restarts. Each worker authenticates with its own credential; only a SHA-256 hash is stored in the gateway.
- **Web BFF** — the browser talks only to the SvelteKit server (HTTP/JSON and Server-Sent Events). The BFF calls the gateway over gRPC with a service token; the browser never sees the gateway address or the token.
- **Mobile** — talks to the gateway directly over Connect, with binary protobuf over HTTP/1.1, through a separate loopback listener meant to sit behind a private TLS proxy. It authenticates with a revocable device token obtained by pairing.
- **Desktop** — loads the same web app. In local mode it also supervises a bundled PostgreSQL, the gateway, a worker and the BFF.

## Components

The repository is a Bun workspace monorepo. Applications depend on packages, never on each other.

| Path | Package | Description |
| --- | --- | --- |
| `apps/gateway` | `@canopy/gateway` | Central server: `GatewayService` for clients, `WorkerLinkService` and `WorkerEnrollmentService` for workers, mobile pairing, orchestration, bots, connectors, migrations. |
| `apps/worker` | `@canopy/worker` | Runs on each machine: link to the gateway, local journal, remotely applied configuration, adapters for Claude, Codex and Grok. CLI commands: `enroll`, start, `service` (prints a systemd/launchd unit). |
| `apps/web` | `@canopy/web` | SvelteKit app (adapter-node) acting as BFF and UI. |
| `apps/desktop` | `@canopy/desktop` | Electron app. **Local mode** runs PostgreSQL, gateway, worker and BFF on loopback with secrets in the OS keychain. **Remote mode** enrolls a worker to an existing gateway and opens its web app. |
| `apps/mobile` | `@canopy/mobile` | Expo / React Native app for iOS and Android (development build). Paired from the web app (Settings → Mobile devices) with a short-lived code or QR; shows threads and bots with live streaming. |
| `packages/contracts` | `@canopy/contracts` | TypeScript generated from `proto/` — the only source of protocol types. |
| `packages/transport` | `@canopy/transport` | HTTP/2 and Connect/gRPC server and client helpers. |
| `packages/db` | `@canopy/db` | PostgreSQL schema (SQL migrations) and migrator. |
| `packages/domain` | `@canopy/domain` | Logic shared by gateway, worker and clients (item projection, agent bus tools and rules). |
| `packages/codex-protocol` | `@canopy/codex-protocol` | Types of the `codex app-server` protocol, generated from a pinned Codex version. |
| `packages/grok-acp` | `@canopy/grok-acp` | Typed client for the Agent Client Protocol over the `grok` CLI's stdio. |
| `packages/ui` | `@canopy/ui` | Design tokens and palette shared by web and mobile. |
| `packages/testing` | `@canopy/testing` | Test helpers (temporary directories, PostgreSQL containers). |
| `tests/integration` | `@canopy/integration-tests` | Gateway ↔ worker integration tests, plus opt-in live tests. |
| `proto/` | — | Protobuf sources (`canopy/ui/v1`, `canopy/worker/v1`). |
| `docs/` | — | Design documents (in Polish). |

## Quick start (development)

Requirements: [Bun](https://bun.sh) 1.4.4 (pinned in `mise.toml`), Docker, `openssl`. Install the agent CLIs you want to use (Claude Code, Codex, `grok`) on the machine that runs the worker; the worker reports which ones it finds.

```bash
bun install
```

**1. PostgreSQL** in Docker, bound to a random local port:

```bash
docker run -d --name canopy-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=canopy \
  -p 127.0.0.1::5432 postgres:17
docker port canopy-pg 5432/tcp   # prints 127.0.0.1:<port>
```

**2. Gateway environment** (keep `CANOPY_SECRETS_KEY` stable — it encrypts secrets stored in the database):

```bash
export CANOPY_DATABASE_URL=postgres://postgres:dev@127.0.0.1:<port>/canopy
export CANOPY_SECRETS_KEY=$(openssl rand -base64 32)
export CANOPY_UI_SERVICE_TOKEN=$(openssl rand -hex 32)
```

**3. Gateway** — applies migrations on start and listens on `0.0.0.0:7443` by default (set `CANOPY_HOST=127.0.0.1` to keep it local):

```bash
bun apps/gateway/src/main.ts
```

**4. Worker** — register it from the CLI (same `CANOPY_DATABASE_URL` and `CANOPY_SECRETS_KEY` as the gateway; it prints the worker's `worker.json` to stdout) and start it:

```bash
bun apps/gateway/src/cli.ts worker add --name laptop --gateway-url http://127.0.0.1:7443 > worker.json
chmod 600 worker.json
CANOPY_WORKER_CONFIG=./worker.json bun apps/worker/src/main.ts
```

Or, once the web app is running, use **Settings → Workers → Add worker**. It creates a one-time token and shows the commands to run on the new machine:

```bash
bun apps/worker/src/main.ts enroll --gateway <gateway-url> --token <token>   # writes worker.json (mode 600) to the default path
bun apps/worker/src/main.ts                                              # start with the default config
bun apps/worker/src/main.ts service                                      # print a systemd (Linux) or launchd (macOS) unit
```

**5. Web app:**

```bash
cd apps/web
GATEWAY_SERVICE_TOKEN=$CANOPY_UI_SERVICE_TOKEN bun run dev   # http://localhost:5173
```

For a production build, run `bun run build`, then `GATEWAY_SERVICE_TOKEN=… PORT=3000 BODY_SIZE_LIMIT=50M bun run start`. Behind a reverse proxy, set `PROTOCOL_HEADER=x-forwarded-proto` (and `HOST_HEADER` if the proxy changes the host). The `50M` body limit fits a 25 MiB skill folder encoded as base64 JSON. Desktop and Docker set it by default; it is server bootstrap configuration. Gateway skill sources require Git and HTTPS network access.

Model access is configured in the UI under **Settings → Providers** (CLI login on the worker, or an API-compatible endpoint with a key).

**Desktop app:**

```bash
bun run --cwd apps/desktop build
bun run --cwd apps/desktop dev
bun run --cwd apps/desktop package:linux   # or package:mac / package:windows on a matching host
```

**Mobile app** (development build; requires Android Studio or Xcode):

```bash
cd apps/mobile
bun run android   # or: bun run ios
```

Open Settings → Mobile devices and choose “Turn on network access and pair a phone”. The app pins this computer's certificate and tries its available addresses; see `docs/mobile.md`.

## Configuration

### Gateway

| Variable | Default | Description |
| --- | --- | --- |
| `CANOPY_DATABASE_URL` | — (required) | PostgreSQL connection URL. |
| `CANOPY_SECRETS_KEY` | — (required) | 32 random bytes, base64. Encrypts secrets in the database; must stay the same across restarts. |
| `CANOPY_UI_SERVICE_TOKEN` | — (required) | Token shared with the web BFF (`GATEWAY_SERVICE_TOKEN`). |
| `CANOPY_HOST` | `0.0.0.0` | Listen address. |
| `CANOPY_PORT` | `7443` | Listen port (gRPC/Connect over HTTP/2; cleartext h2c unless TLS is set). |
| `CANOPY_TLS_CERT`, `CANOPY_TLS_KEY` | — | TLS certificate and key files. |
| `CANOPY_MIGRATE` | `1` | Apply database migrations on start. |
| `CANOPY_DEV_USER_EMAIL` | `dev@localhost` | Owner account created on start (until user login exists). |
| `CANOPY_NETWORK_PORT` | selected in the app | Optional fixed port for server/container deployments of Network access. |

Worker addresses are chosen automatically from Network access; an override is available in Settings → Workers. Attachment limits are editable in Settings → Network access. Worker enrollment commands include this computer's certificate fingerprint.

### Web (BFF)

| Variable | Default | Description |
| --- | --- | --- |
| `GATEWAY_URL` | `http://127.0.0.1:7443` | Gateway endpoint. |
| `GATEWAY_SERVICE_TOKEN` | — (required at runtime) | Same value as the gateway's `CANOPY_UI_SERVICE_TOKEN`, at least 32 characters. |
| `PORT`, `HOST`, `PROTOCOL_HEADER`, `HOST_HEADER`, `BODY_SIZE_LIMIT` | adapter-node defaults | Standard SvelteKit adapter-node settings. |

### Worker

| Variable | Default | Description |
| --- | --- | --- |
| `CANOPY_WORKER_CONFIG` | `~/.config/canopy/worker.json` on Linux (`$XDG_CONFIG_HOME` if set), `~/Library/Application Support/canopy/worker.json` on macOS, `%APPDATA%\canopy\worker.json` on Windows | Path to `worker.json` (`gateway_url`, `worker_id`, `credential`, optional `data_dir`, `ca_file`). Written by `enroll` or `worker add`. On Linux and macOS the worker refuses to start if group or other users can access the file (use mode 600). Without `data_dir` the worker keeps its journal and agent homes in `~/.local/share/canopy` on Linux (`$XDG_DATA_HOME` if set), `~/Library/Application Support/canopy` on macOS, `%LOCALAPPDATA%\canopy` on Windows. |
| `CANOPY_WORKER_STATUS_FILE` | — | Optional file where the worker reports its link status (used by the desktop app). |

The gateway sends everything else a worker needs (enabled harnesses, provider instances, keys and limits), and you manage all of it in the UI.

## Platform support

| Platform | Worker | Desktop app |
| --- | --- | --- |
| Linux x64 | Verified | Verified (AppImage) |
| Linux arm64 | Not verified | Configured, not built |
| macOS | Supported in code (paths, launchd unit), not verified | Configured (dmg), not built |
| Windows x64 | Supported in code (paths), not verified | Configured (NSIS), not built |

The mobile app has been verified on the iOS Simulator and the Android Emulator as a development build.

## Status and roadmap

**Implemented**

- Gateway, workers and web app work end to end with Claude, Codex and Grok, using native CLI logins or API-compatible endpoints.
- Threads: queue and steer, forks, archive, side threads across providers, agent bus, approvals and questions, goals, schedules, background tasks, secrets, generated titles, threads without a project.
- Bots with routines, reminders, bot-to-bot conversations, bot creation, approval policies including full auto, and silent handoff on model change.
- Connectors with named accounts, per-worker and per-bot grants, OAuth or token authentication, and an audit log.
- Worker enrollment from the UI, credential rotation, revocation and archiving.
- [Gateway and worker updates](docs/updates.md): a separate frozen gRPC protocol, compatibility negotiation, gateway mirror, verified Linux/macOS binary replacement, rollback and Settings controls. Runtime verified on Linux; Windows binaries remain externally managed.
- Desktop app (Linux verified) and mobile development build (iOS and Android).

**In progress**

- CI pipeline, container images, standalone gateway and worker binaries, desktop builds on CI, and a single version across all apps with `stable`, `beta`, `nightly` and stable version pins.

**Planned**

- User accounts and login; real multi-user operation (data is already scoped per owner).
- Shared (global) and private agent definitions.
- Chat threads that run in the gateway without a worker.
- Verified builds and workers on macOS, Windows and Linux arm64.
- Mobile releases through the app stores; push notifications.

## Releases and deployment

One version for every app: Angular squash commits drive semantic-release on `dev` (nightly), `next` (beta) and `main` (stable). `latest` now means stable. Docker images `ghcr.io/itsoltech/canopy-{gateway,web,worker}`, standalone `canopy-gateway` / `canopy-worker` binaries and desktop installers share that exact version. Maintainers promote tested commits through the channels. See `docs/release.md` (bootstrap 0.1.0, burn-in, CI, artifacts), `docs/contributing.md` (commits and PR targets) and `docs/deploy.md` (installation and upgrades).

## Contributing

Bug reports and feature ideas are welcome as issues. Source code contributions (pull requests, patches) are accepted only from employees or authorized contractors of IT SOL Sp. z o.o.; see [LICENSE.md](LICENSE.md).

```bash
bun install
bun run gen          # regenerate protocol code from proto/
bun run typecheck    # all workspaces
bun test             # unit and integration tests (PostgreSQL tests need Docker)
bun run check:tmp    # tests with a private TMPDIR; fails if tests leave temporary directories behind
bun run check        # gen:check + typecheck + check:tmp
```

- Protocol types come only from `@canopy/contracts`; generated code under `src/gen` is committed and `bun run gen:check` verifies it is current.
- TypeScript runs in strict mode (`tsconfig.base.json`).
- Tests that call real models (`*.live.test.ts`) are opt-in: they run only with `CANOPY_LIVE=1` and need provider credentials described in each test file.

## License

Canopy is source-available under the [Canopy Source-Available License](LICENSE.md). You may use it for any purpose, including commercial work, and read its source. Only IT SOL Sp. z o.o. and its authorized contractors may modify the code; redistribution and derivative works need written permission.
