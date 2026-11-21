import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";
import { installKind } from "@canopy/updater";
import { Schema } from "effect";
import { healthcheck } from "../healthcheck.ts";
import { embeddedWebOrigin, embeddedWebWanted } from "../web/config.ts";
import { EMBEDDED_WEB } from "../web/embedded.ts";
import { CutoverError, readCutoverFile, requirePrivateDirectory, writeCutoverFile } from "./cutover-files.ts";

const absolutePath = Schema.String.check(Schema.makeFilter((value) => isAbsolute(value) && !value.includes("\0")));
const argv = Schema.NonEmptyArray(Schema.String.check(Schema.makeFilter((value) => !value.includes("\0"))));

const nativeService = Schema.Struct({
  unit: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-][a-zA-Z0-9_.@:-]*\.service$/))),
  user: Schema.optional(Schema.Boolean),
});

const hookedService = Schema.Struct({ stop: argv, start: argv, stopped: argv, ready: argv });
const serviceConfig = Schema.Union([nativeService, hookedService]);

const networkOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);

    return url?.protocol === "https:" && value === url.origin;
  }),
);

export const hostFields = {
  stateDirectory: absolutePath,
  environmentFile: Schema.optional(absolutePath),
  service: Schema.optional(serviceConfig),
  secretFile: Schema.optional(absolutePath),
  networkOrigins: Schema.optional(Schema.Array(networkOrigin).check(Schema.isMaxLength(8))),
};

const decodeHost = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct(hostFields)), {
  onExcessProperty: "error",
});

type HostConfig = typeof decodeHost extends (input: string) => infer T ? T : never;

export interface CutoverHost {
  stateDirectory: string;
  secretFile: string;
  service: typeof serviceConfig.Type;
  networkOrigins: readonly string[];
  env: NodeJS.ProcessEnv;
}

export interface CutoverService {
  stopped(): Promise<boolean>;
  stop(): Promise<void>;
  start(): Promise<void>;
  ready(): Promise<boolean>;
}

export function targetConfigPath(env: NodeJS.ProcessEnv) {
  return env["CANOPY_MIGRATION_TARGET_CONFIG"] ?? join(homedir(), ".config", "canopy", "gateway-migration-target.json");
}

export async function loadCutoverHost(configPath: string, env: NodeJS.ProcessEnv) {
  const config = await readCutoverFile(configPath, decodeHost);

  if (!config) throw new CutoverError("Create the private cutover host configuration file.");

  return resolveCutoverHost(config, env);
}

export async function resolveCutoverHost(config: HostConfig, env: NodeJS.ProcessEnv): Promise<CutoverHost> {
  await requirePrivateDirectory(config.stateDirectory);
  const configuration = config.environmentFile && (await readCutoverFile(config.environmentFile, parseEnv));

  if (config.environmentFile && !configuration) throw new CutoverError("The cutover environment file is missing.");

  const secretFile = config.secretFile ?? join(config.stateDirectory, "gateway-secrets.env");
  await requirePrivateDirectory(dirname(secretFile));

  return {
    stateDirectory: config.stateDirectory,
    secretFile,
    service: config.service ?? {},
    networkOrigins: [...new Set(config.networkOrigins)],
    env: { ...env, ...configuration },
  };
}

function runHook(args: readonly string[], env: NodeJS.ProcessEnv) {
  return Bun.spawn([...args], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
}

function systemd(unit: typeof nativeService.Type, env: NodeJS.ProcessEnv): CutoverService {
  const service = unit.unit ?? "canopy-gateway.service";
  const systemctl = unit.user ? ["systemctl", "--user"] : ["systemctl"];
  const run = (action: string) => runHook([...systemctl, action, "--", service], env);
  const web = EMBEDDED_WEB && embeddedWebWanted(env, installKind(env)) ? embeddedWebOrigin(env) : undefined;

  return {
    stop: () => requireHook(run("stop"), "stop"),
    start: () => requireHook(run("start"), "start"),
    ready: async () => (await run("is-active")) === 0 && (await healthcheck(env, web)) === 0,
    stopped: async () => {
      const child = Bun.spawn([...systemctl, "show", "--property=LoadState", "--property=ActiveState", "--", service], {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });

      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);

      if (code !== 0 || !/^LoadState=loaded$/m.test(output))
        throw new CutoverError("The gateway systemd unit must be installed and loadable.");

      return /^ActiveState=(inactive|failed)$/m.test(output);
    },
  };
}

async function requireHook(code: Promise<number>, action: "stop" | "start") {
  if ((await code) !== 0) throw new CutoverError(`The gateway service could not ${action}.`);
}

export function cutoverService(host: CutoverHost, overrides?: NodeJS.ProcessEnv): CutoverService {
  const { service } = host;
  const env = { ...host.env, ...overrides };

  if (!("start" in service)) return systemd(service, env);

  return {
    stop: () => requireHook(runHook(service.stop, env), "stop"),
    start: () => requireHook(runHook(service.start, env), "start"),
    stopped: async () => {
      const code = await runHook(service.stopped, env);

      if (code !== 0 && code !== 1) throw new CutoverError("The gateway service state hook failed.");

      return code === 0;
    },
    ready: async () => (await runHook(service.ready, env)) === 0,
  };
}

export function waitForCutoverService(service: CutoverService, message: string) {
  return pollForReadiness(() => service.ready(), message);
}

export async function recoverCutoverService(service: CutoverService, shuttingDown: boolean, message: string) {
  let started = shuttingDown;

  if (shuttingDown) {
    await service.stop();
    await service.start();
  }

  await pollForReadiness(async () => {
    if (await service.ready()) return true;

    if (!started && (await service.stopped())) {
      await service.start();
      started = true;
    }

    return false;
  }, message);
}

async function pollForReadiness(probe: () => Promise<boolean>, message: string) {
  const deadline = performance.now() + 60_000;

  while (!(await probe())) {
    if (performance.now() >= deadline) throw new CutoverError(message);
    await Bun.sleep(500);
  }
}

export async function installTargetKey(host: CutoverHost, key: string) {
  const content = `CANOPY_SECRETS_KEY=${key}\n`;
  const existing = await readCutoverFile(host.secretFile, (value) => value, 128);

  if (existing === content) return;

  if (existing !== undefined) throw new CutoverError("The target gateway key file belongs to another installation.");

  await writeCutoverFile(host.secretFile, content);
}
