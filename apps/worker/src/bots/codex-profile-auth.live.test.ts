import { expect, spyOn, test } from "bun:test";
import { Database, SQLiteError } from "bun:sqlite";
import * as fs from "node:fs";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep, toNamespacedPath } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Provider, RunBotTurnSchema } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import { Effect, Schema } from "effect";
import { fakeModelHandler } from "../import/fixtures/fake-model.ts";
import { CodexAppServerError, CodexAppServerStartupError } from "../providers/codex/app-server.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { profileBotLogin } from "../providers/codex/profile-auth.ts";
import { decodeJsonObject, jsonObject } from "../providers/json.ts";
import type { ResolvedProfile } from "../providers/profiles.ts";
import { runCodexBot } from "./codex.ts";
import { botSession } from "./session.ts";
import { BotHarnessFailure } from "./types.ts";

const temp = tempDirs();
const enabled = process.env["CANOPY_LIVE_CODEX_PROFILE_AUTH"] === "1";
const model = "gpt-5.4";
const accountId = crypto.randomUUID();
const userId = crypto.randomUUID();
const profileInstructions = "FIXTURE_SOURCE_PROFILE_INSTRUCTIONS";
const botInstructions = "FIXTURE_BOT_INSTRUCTIONS";
const readRefresh = Schema.decodeUnknownSync(Schema.Struct({ refresh_token: Schema.String }));
const historyDatabase = "thread_history_1.sqlite";
const windowsMaxPath = 260;

// A cold turn starts a catalog process, the bot app-server and the selected profile's auth probe.
const turnTimeoutMs = 60_000;

function sqliteCause(message: string) {
  const lower = message.toLowerCase();

  return [
    "unable to open database file",
    "database is locked",
    "database table is locked",
    "database schema is locked",
    "database is busy",
    "no such table",
    "no such column",
    "database disk image is malformed",
    "file is not a database",
    "attempt to write a readonly database",
    "disk i/o error",
    "database or disk is full",
    "permission denied",
  ].find((cause) => lower.includes(cause));
}

function safeFailure(error: Error): string {
  const kind =
    error instanceof CodexAppServerError
      ? (["thread/start", "thread/resume", "turn/start", "config/read"].find((method) => method === error.method) ??
        "rpc")
      : error instanceof CodexAppServerStartupError
        ? "app-server startup"
        : error instanceof BotHarnessFailure
          ? "harness"
          : "other";

  const stages = [
    [/failed to open thread history database/i, "open thread history database"],
    [/failed to (?:open|migrate|validate) thread history DB/i, "initialize thread history database"],
    [/did not include persisted history/i, "missing persisted history"],
    [/thread writer lock|already has an active writer/i, "thread writer lock"],
    [/failed to resume local thread recorder/i, "reopen rollout recorder"],
    [/failed to initialize thread persistence/i, "initialize thread persistence"],
    [/failed to resolve rollout path/i, "resolve rollout path"],
    [/failed to load thread history/i, "load thread history"],
    [/failed to read thread:/i, "read stored thread"],
    [/failed to build resume response/i, "build resume response"],
    [/session configured event was not the first event|internal channel closed/i, "session startup event"],
  ] as const;

  const reasons = [
    [/os error 206|filename.*too long|path.*too long/i, "path length"],
    [/os error 32|os error 33|sharing violation|locked|busy/i, "file busy"],
    [/os error 5|permission|access.*denied/i, "file permission"],
    [/sqlite|database|persisted history/i, "history store"],
    [/rollout|transcript|session.*file/i, "rollout"],
    [/error resuming thread/i, "thread restore"],
    [/app-server disconnected|transport.*closed|closed.*pipe/i, "closed transport"],
    [/sandbox/i, "sandbox"],
    [/not found|no such file|os error [23]\b/i, "missing file"],
    [/invalid config|configuration/i, "configuration"],
  ] as const;

  const code = error instanceof CodexAppServerError ? error.code : undefined;
  const stage = stages.find(([pattern]) => pattern.test(error.message))?.[1];
  const reason = sqliteCause(error.message) ?? reasons.find(([pattern]) => pattern.test(error.message))?.[1];

  const sqliteCode =
    /(?:error returned from database:\s*\(code:|sqlite(?: error)?(?: code)?\s*[:=]?)\s*(\d{1,5})\b/i.exec(
      error.message,
    )?.[1];

  const osCode = /os error (\d{1,4})\b/i.exec(error.message)?.[1];

  return [
    kind,
    stage,
    reason ?? (stage ? undefined : "unclassified"),
    code === undefined ? undefined : `RPC ${code}`,
    sqliteCode && `SQLite ${sqliteCode}`,
    osCode && `OS ${osCode}`,
  ]
    .filter(Boolean)
    .join(", ");
}

function fixtureFile(home: string, path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });

  if (!stat) return undefined;
  const inside = relative(fs.realpathSync(home), fs.realpathSync(path));

  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    !inside ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  )
    throw new Error("Unexpected fixture file");

  return stat;
}

function rolloutDiagnostic(home: string, path: string, id: string): string {
  if (!isAbsolute(path)) return "path unavailable";

  try {
    const stat = fixtureFile(home, path);

    if (!stat) return "missing";
    const contents = readFileSync(path, "utf8");
    const lines = contents.trimEnd().split("\n");

    if (!contents) return "empty";

    try {
      const records = lines.map((line) => decodeJsonObject(JSON.parse(line)));
      const first = records[0];
      const metadataMatches = first?.["type"] === "session_meta" && jsonObject(first["payload"])?.["id"] === id;

      const completedTurns = records.filter((record) => {
        const type = jsonObject(record["payload"])?.["type"];

        return record["type"] === "event_msg" && (type === "task_complete" || type === "turn_complete");
      }).length;

      return `${stat.size} bytes, ${lines.length} records, final newline ${contents.endsWith("\n")}, matching metadata ${metadataMatches}, completed turns ${completedTurns}`;
    } catch {
      return `${stat.size} bytes, malformed JSONL`;
    }
  } catch {
    return "unreadable";
  }
}

function sqliteDiagnostic(home: string, filename: string, summarize: (db: Database) => string): string {
  const database = join(home, filename);
  let state = "unreadable";

  try {
    if (!fixtureFile(home, database)) return "missing";

    for (const suffix of ["-wal", "-shm", "-journal"]) fixtureFile(home, database + suffix);
    using db = new Database(database, { readonly: true });
    const healthy = db.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").get()?.quick_check === "ok";
    state = `quick check ${healthy}`;

    return `${state}, ${summarize(db)}`;
  } catch (error) {
    if (!(error instanceof SQLiteError)) return state;
    const cause = sqliteCause(error.message);

    return `${state} (SQLite ${error.errno}${cause ? `, ${cause}` : ""})`;
  }
}

function indexDiagnostic(home: string, path: string, id: string): string {
  return sqliteDiagnostic(home, "state_5.sqlite", (db) => {
    const row = db
      .query<{ rollout_path: string; model_provider: string; archived: number }, [string]>(
        "SELECT rollout_path, model_provider, archived FROM threads WHERE id = ?",
      )
      .get(id);

    if (!row) return "session row missing";

    const matchingPath =
      isAbsolute(path) &&
      isAbsolute(row.rollout_path) &&
      relative(toNamespacedPath(path), toNamespacedPath(row.rollout_path)) === "";

    return `matching path ${matchingPath}, native provider ${row.model_provider === "openai"}, archived ${row.archived === 1}`;
  });
}

function historyDiagnostic(home: string): string {
  return sqliteDiagnostic(home, historyDatabase, (db) => {
    const turns = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM thread_turns").get()?.count;

    return `projected turns ${turns}`;
  });
}

function fictionalLogin() {
  const idToken = jwt({
    email: "codex-fixture@example.invalid",
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
      chatgpt_plan_type: "plus",
    },
  });

  return {
    id_token: idToken,
    access_token: jwt({
      email: "codex-fixture@example.invalid",
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: crypto.randomUUID(),
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_user_id: userId,
        chatgpt_plan_type: "plus",
      },
    }),
    refresh_token: crypto.randomUUID(),
  };
}

function jwt(claims: JsonObject): string {
  const encode = (value: JsonObject) => Buffer.from(JSON.stringify(value)).toString("base64url");

  return `${encode({ alg: "none" })}.${encode(claims)}.fictional`;
}

function writeLogin(home: string, login: ReturnType<typeof fictionalLogin>) {
  const file = join(home, "auth.json");
  const staged = `${file}.new`;
  writeFileSync(
    staged,
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { ...login, account_id: accountId },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  renameSync(staged, file);
}

function scanIfPresent<A>(read: () => A): A | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function readFixtureFile(path: string, live: boolean) {
  return scanIfPresent(() => {
    try {
      return readFileSync(path);
    } catch (error) {
      // SQLite locks bytes in its WAL index on Windows. The database and WAL still contain all row data.
      if (
        live &&
        process.platform === "win32" &&
        path.endsWith(".sqlite-shm") &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EBUSY"
      )
        return undefined;
      throw error;
    }
  });
}

function cleanFixtureFiles(
  root: string,
  forbidden: readonly string[],
  live: boolean,
  sourceAuthFile?: string,
): boolean {
  for (const entry of scanIfPresent(() => readdirSync(root)) ?? []) {
    const path = join(root, entry);
    const stat = lstatSync(path, { throwIfNoEntry: false });

    if (!stat) continue;

    if (stat.isSymbolicLink()) {
      // Native Linux Codex creates executable aliases while the source probe is running.
      if (
        sourceAuthFile &&
        process.platform === "linux" &&
        /^tmp\/arg0-linux\/codex-arg0[^/]+\/(?:apply_patch|applypatch|codex-linux-sandbox)$/u.test(
          relative(dirname(sourceAuthFile), path),
        )
      )
        continue;

      return false;
    }

    if (!sourceAuthFile && entry.startsWith("auth.json")) return false;

    if (stat.isDirectory()) {
      if (!cleanFixtureFiles(path, forbidden, live, sourceAuthFile)) return false;
      continue;
    }

    // Read binary data too, including SQLite and a live WAL if the CLI creates one.
    if (!stat.isFile() || stat.nlink !== 1) return false;

    // The native CLI keeps its empty startup and helper lockfiles exclusively open on Windows.
    // No bytes can be present in an empty file. The scan still checks file type and link count.
    if (path === sourceAuthFile || (live && process.platform === "win32" && stat.size === 0)) continue;
    const contents = readFixtureFile(path, live);

    if (contents && forbidden.some((token) => contents.includes(token))) return false;
  }

  return true;
}

function localBackend(
  logins: readonly [
    ReturnType<typeof fictionalLogin>,
    ReturnType<typeof fictionalLogin>,
    ReturnType<typeof fictionalLogin>,
  ],
  fixtureFilesClean: () => boolean,
) {
  const model = fakeModelHandler();
  const authAttempts: number[] = [];
  const failures = new Set<string>();
  let refreshes = 0;
  let clean = true;
  let rejectSecond = false;

  function scanFiles() {
    try {
      clean &&= fixtureFilesClean();
    } catch (error) {
      clean = false;
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      const errno = Schema.is(Schema.String)(code) && /^E[A-Z0-9]+$/u.test(code) ? ` (${code})` : "";
      failures.add(`live file scan${errno}`);
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    error() {
      failures.add("HTTP handler");

      return new Response(null, { status: 500 });
    },
    async fetch(request) {
      const path = new URL(request.url).pathname;

      if (request.method === "POST" && path === "/oauth/token") {
        refreshes++;
        scanFiles();
        const refresh = readRefresh(await request.json()).refresh_token;

        if (refresh === logins[1].refresh_token && rejectSecond) return Response.json(logins[2]);

        return new Response(null, { status: 400 });
      }

      if (request.method === "GET" && path.endsWith("/models")) return Response.json({ models: [] });

      if (request.method !== "POST" || !path.endsWith("/responses")) return new Response(null, { status: 404 });
      const bearer = request.headers.get("authorization");
      const generation = logins.findIndex((login) => bearer === `Bearer ${login.access_token}`);
      authAttempts.push(generation);
      scanFiles();

      if (request.headers.get("chatgpt-account-id") !== accountId || generation < 0) {
        failures.add("model authorization");

        return new Response(null, { status: 403 });
      }

      if (generation === 1 && rejectSecond) return new Response(null, { status: 401 });

      try {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const body = request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes;
        const response = model.respond(request.method, path, new TextDecoder().decode(body));

        if (!response.ok) failures.add(`model response ${response.status}`);

        return response;
      } catch {
        failures.add("model request decoding");

        return new Response(null, { status: 500 });
      }
    },
  });

  return {
    url: server.url.origin,
    authAttempts,
    failures,
    requests: model.requests,
    get refreshes() {
      return refreshes;
    },
    get clean() {
      return clean;
    },
    rejectSecond() {
      rejectSecond = true;
    },
    stop: () => server.stop(true),
  };
}

function fixtureExecutable(): string {
  const path = process.env["CANOPY_LIVE_CODEX_BIN"] ?? Bun.which(process.platform === "win32" ? "codex.exe" : "codex");

  if (!path || !isAbsolute(path) || (process.platform === "win32" && !path.toLowerCase().endsWith(".exe")))
    throw new Error("A native Codex CLI executable is required for the local profile login test.");
  const cli = Bun.spawnSync([path, "--version"], { stderr: "ignore" });
  const expected = process.env["CANOPY_LIVE_CODEX_EXPECT_VERSION"];
  const version = /^codex-cli (\d+\.\d+\.\d+)\s*$/u.exec(cli.stdout.toString())?.[1];

  if (cli.exitCode !== 0 || !version || (expected && version !== expected))
    throw new Error("The native Codex CLI version does not match the fixture version.");

  return path;
}

test.skipIf(!enabled)(
  "real Codex bot uses the selected ChatGPT profile across external rotation, OAuth refresh and sign-out",
  async () => {
    if (process.env["CANOPY_LIVE_CODEX_EXPECT_WINDOWS"] === "1") expect(process.platform).toBe("win32");
    const executable = fixtureExecutable();
    const root = temp("canopy-bot-profile-auth-");
    const source = join(root, "profile");
    const sourceAuthFile = join(source, "auth.json");
    // The nested conversation home must exercise the legacy SQLite path limit even under a short Windows temp path.
    const dataDir = join(root, "data".padEnd(process.platform === "win32" ? Math.max(4, 79 - root.length) : 4, "x"));
    mkdirSync(source);
    mkdirSync(dataDir);
    const logins = [fictionalLogin(), fictionalLogin(), fictionalLogin()] as const;

    const forbidden = logins.flatMap(({ id_token, access_token, refresh_token }) => [
      id_token,
      access_token,
      refresh_token,
    ]);

    const checkBotFiles = (live = false) => cleanFixtureFiles(dataDir, forbidden, live);
    const checkSourceFiles = (live = false) => cleanFixtureFiles(source, forbidden, live, sourceAuthFile);
    const backend = localBackend(logins, () => checkBotFiles(true) && checkSourceFiles(true));

    const input = create(RunBotTurnSchema, {
      botId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      profileId: "fixture",
      provider: Provider.CODEX,
      model,
      instructions: botInstructions,
    });

    const profile: ResolvedProfile = {
      id: input.profileId,
      kind: "native",
      providers: ["codex"],
      runtime: {},
      env: {
        CODEX_ACCESS_TOKEN: "",
        CODEX_API_KEY: "",
        CODEX_SQLITE_HOME: "",
        OPENAI_API_KEY: "",
        CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${backend.url}/oauth/token`,
        HTTP_PROXY: backend.url,
        HTTPS_PROXY: backend.url,
        ALL_PROXY: backend.url,
        NO_PROXY: "127.0.0.1",
        ...(process.platform !== "win32" && {
          http_proxy: backend.url,
          https_proxy: backend.url,
          all_proxy: backend.url,
          no_proxy: "127.0.0.1",
        }),
      },
    };

    const features = [
      "features.plugins = false",
      "features.apps = false",
      "features.responses_websockets = false",
      "features.responses_websockets_v2 = false",
      "analytics.enabled = false",
    ].join("\n");

    const config = [
      `openai_base_url = "${backend.url}/v1"`,
      `chatgpt_base_url = "${backend.url}/backend-api"`,
      features,
    ].join("\n");

    // This also covers runners with Developer Mode enabled. The child remains the real native CLI.
    const deniedSymlink = spyOn(fs, "symlinkSync").mockImplementation(() => {
      throw new Error("Symbolic links are disabled for this fixture.");
    });

    try {
      writeFileSync(
        join(source, "config.toml"),
        `developer_instructions = "${profileInstructions}"\ncli_auth_credentials_store = "file"\n${config}\n`,
      );
      writeLogin(source, logins[0]);

      const sourceLaunch = codexAppServerLaunch([profile], process.env, executable, undefined, source, {
        ...profile.env,
        HOME: source,
        USERPROFILE: source,
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const login = yield* profileBotLogin({ launch: sourceLaunch, clientVersion: "test" });
          yield* Effect.promise(async () => {
            const sessionOptions = { dataDir, sourceHome: source, linkLogin: true };
            const fresh = botSession(input, sessionOptions);
            const botConfig = join(fresh.home, "config.toml");
            const sqliteHome = fresh.codexSqliteHome ?? fresh.home;
            const sqliteHistory = join(sqliteHome, historyDatabase);

            if (process.platform === "win32") {
              const legacyHistory = join(fresh.home, historyDatabase);
              expect(legacyHistory.length, "Original Codex history database path length").toBeGreaterThanOrEqual(
                windowsMaxPath,
              );
              expect(
                `${legacyHistory}-journal`.length,
                "Original Codex SQLite journal path length",
              ).toBeGreaterThanOrEqual(windowsMaxPath);
              expect(`${sqliteHistory}-journal`.length, "Private SQLite journal path length").toBeLessThan(
                windowsMaxPath,
              );
            }

            writeFileSync(botConfig, config);
            let lastSessionId = "";
            let lastTranscript = "";

            const turn = async (text: string, expected: "completed" | "auth_required" = "completed") => {
              const next = { ...input, turnId: crypto.randomUUID() };
              const session = botSession(next, sessionOptions);
              const signal = AbortSignal.timeout(turnTimeoutMs);
              expect(session.id === lastSessionId).toBe(true);
              expect(
                (session.codexSqliteHome ?? session.home) === sqliteHome,
                "The conversation reuses its SQLite home",
              ).toBe(true);
              let admittedLogin = false;
              let completed = false;
              let cleanEvents = true;
              let outcome = "completed";
              let failure = "";
              let phase = "before profile login";

              try {
                await runCodexBot({
                  input: next,
                  profile,
                  executable,
                  clientVersion: "test",
                  signal,
                  session,
                  codexLogin: async (destination, scope) => {
                    phase = scope ? "during profile credential refresh" : "during profile credential lookup";
                    const credential = await Effect.runPromise(login(destination, scope), { signal });
                    admittedLogin = true;
                    phase = scope ? "after profile credential refresh" : "after profile credential lookup";

                    return credential;
                  },
                  mcp: { url: backend.url, headers: {} },
                  record: async (event) => {
                    const eventText = Bun.inspect(event, { depth: 8 });
                    cleanEvents &&= !forbidden.some((token) => eventText.includes(token));
                    const body = event.body;
                    const content = body?.case === "itemCompleted" ? body.value?.item?.content : undefined;
                    completed ||= content?.case === "agentMessage" && content.value?.text === `FIXTURE_ANSWER ${text}`;
                  },
                  noteHarness: async (harness) => {
                    lastSessionId = harness.sessionId;
                    lastTranscript = harness.transcript;
                    phase = harness.providerTurn ? "after turn admission" : "after conversation admission";
                  },
                  content: async () => ({ text, images: [], documents: [] }),
                });
              } catch (error) {
                const errorText = Bun.inspect(error, { depth: 8 });
                expect(
                  forbidden.some((token) => errorText.includes(token)),
                  "Worker error contained credentials",
                ).toBe(false);
                outcome = error instanceof BotHarnessFailure && error.code === "auth_required" ? error.code : "failed";
                failure = Error.isError(error) ? safeFailure(error) : "non-error";

                if (error instanceof CodexAppServerError && error.method === "thread/resume" && error.code === -32603) {
                  const { home, id } = session;
                  failure += `, rollout [${rolloutDiagnostic(home, lastTranscript, id)}]`;
                  failure += `, SQLite index [${indexDiagnostic(sqliteHome, lastTranscript, id)}], history [${historyDiagnostic(sqliteHome)}]`;
                  failure += `, path lengths [home ${home.length}, rollout ${lastTranscript.length}, history ${sqliteHistory.length}]`;
                }
              }

              const diagnostics = `${phase}, failure ${failure}, model generations ${backend.authAttempts}, fixture failures ${[...backend.failures]}`;
              expect(signal.aborted, `Bot turn ${text} exceeded ${turnTimeoutMs} ms at ${diagnostics}`).toBe(false);
              expect(outcome, `Expected bot outcome for ${text} after ${diagnostics}`).toBe(expected);
              expect(backend.clean, `Bot or profile files failed audit during ${text} after ${diagnostics}`).toBe(true);
              expect(admittedLogin, "Selected profile delivered a credential").toBe(expected === "completed");
              expect(completed, "Expected mock model reply").toBe(expected === "completed");

              if (session.id && expected === "completed")
                expect(lastSessionId === session.id, "Codex resumed the original native session").toBe(true);

              expect(cleanEvents, "Worker event contained credentials").toBe(true);
              expect(checkBotFiles(), "Bot persisted credentials or created a link").toBe(true);
              expect(checkSourceFiles(), "Profile persisted credentials outside its login file or created a link").toBe(
                true,
              );
            };

            await turn("FIXTURE_FIRST");
            writeLogin(source, logins[1]);
            await turn("FIXTURE_SECOND");

            if (process.platform === "win32")
              expect(
                fixtureFile(dataDir, sqliteHistory)?.size ?? 0,
                "Regular history database in audited bot storage",
              ).toBeGreaterThan(0);

            backend.rejectSecond();
            await turn("FIXTURE_REFRESHED");
            const refreshed = readFileSync(sourceAuthFile, "utf8");
            expect(refreshed.includes(logins[2].refresh_token)).toBe(true);
            writeFileSync(botConfig, features);
            await turn("FIXTURE_MISMATCHED_ROUTE", "auth_required");
            writeFileSync(botConfig, config);
            unlinkSync(sourceAuthFile);
            await turn("FIXTURE_SIGNED_OUT", "auth_required");
          });
        }).pipe(Effect.scoped),
      );

      expect(backend.authAttempts).toEqual([0, 1, 1, 2]);
      expect(backend.refreshes).toBe(1);
      expect(deniedSymlink.mock.calls.length).toBe(0);
      expect([...backend.failures], "Loopback backend failures").toEqual([]);
      expect(backend.requests).toHaveLength(3);
      const second = backend.requests[1] ?? "";
      expect(second.includes("FIXTURE_FIRST") && second.includes("FIXTURE_SECOND")).toBe(true);
      expect(second.includes(botInstructions) && !second.includes(profileInstructions)).toBe(true);
    } finally {
      deniedSymlink.mockRestore();
      await backend.stop();
    }
  },
  5 * turnTimeoutMs + 20_000,
);
