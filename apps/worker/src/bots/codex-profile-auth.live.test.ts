import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Provider, RunBotTurnSchema } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import { Effect, Schema } from "effect";
import { fakeModelHandler } from "../import/fixtures/fake-model.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { profileBotLogin } from "../providers/codex/profile-auth.ts";
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

    if (stat.isDirectory() && !cleanFixtureFiles(path, forbidden, live, sourceAuthFile)) return false;

    // Read binary data too, including SQLite and a live WAL if the CLI creates one.
    if (stat.isFile()) {
      if (stat.nlink !== 1) return false;

      if (path === sourceAuthFile) continue;
      const contents = readFixtureFile(path, live);

      if (contents && forbidden.some((token) => contents.includes(token))) return false;
    }
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
    mkdirSync(source);
    const logins = [fictionalLogin(), fictionalLogin(), fictionalLogin()] as const;
    const forbidden = logins.flatMap(({ access_token, refresh_token }) => [access_token, refresh_token]);
    const botDirs = join(root, "bots");
    const checkBotFiles = (live = false) => cleanFixtureFiles(botDirs, forbidden, live);
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
            const sessionOptions = { dataDir: root, sourceHome: source, linkLogin: true };
            const fresh = botSession(input, sessionOptions);
            const botConfig = join(fresh.home, "config.toml");
            writeFileSync(botConfig, config);
            let lastSessionId = "";

            const turn = async (text: string, expected: "completed" | "auth_required" = "completed") => {
              const next = { ...input, turnId: crypto.randomUUID() };
              const session = botSession(next, sessionOptions);
              const signal = AbortSignal.timeout(25_000);
              expect(session.id === lastSessionId).toBe(true);
              let admittedLogin = false;
              let completed = false;
              let cleanEvents = true;
              let outcome = "completed";

              try {
                await runCodexBot({
                  input: next,
                  profile,
                  executable,
                  clientVersion: "test",
                  signal,
                  session,
                  codexLogin: async (destination, scope) => {
                    const credential = await Effect.runPromise(login(destination, scope), { signal });
                    admittedLogin = true;

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
              }

              const diagnostics = `model generations ${backend.authAttempts}, fixture failures ${[...backend.failures]}`;
              expect(outcome, `Expected bot outcome for ${text} after ${diagnostics}`).toBe(expected);
              expect(backend.clean, `Bot or profile files failed audit during ${text} after ${diagnostics}`).toBe(true);
              expect(admittedLogin, "Selected profile delivered a credential").toBe(expected === "completed");
              expect(completed, "Expected mock model reply").toBe(expected === "completed");
              expect(cleanEvents, "Worker event contained credentials").toBe(true);
              expect(checkBotFiles(), "Bot persisted credentials or created a link").toBe(true);
              expect(checkSourceFiles(), "Profile persisted credentials outside its login file or created a link").toBe(
                true,
              );
            };

            await turn("FIXTURE_FIRST");
            writeLogin(source, logins[1]);
            await turn("FIXTURE_SECOND");
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
  140_000,
);
