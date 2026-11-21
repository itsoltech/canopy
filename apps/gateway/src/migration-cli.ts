import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Match } from "effect";
import { exportBundle, importBundle, MigrationBundleError, verifyBundle } from "./migration/bundle.ts";
import { CutoverError } from "./migration/cutover-files.ts";
import { runCutoverSource, type SourceAction } from "./migration/cutover-source.ts";
import { handleCutoverTarget } from "./migration/cutover-target.ts";
import { inspectLinks } from "./migration/inspect-links.ts";
import { DatabaseMigrationError, inspectDatabaseCapacity } from "./migration/postgres.ts";
import { abortFence, commitSourceFence, readFence, requestDrain } from "./migration/relocation-fence.ts";

const USAGE = `Usage:
  canopy-gateway migration export --bundle DIRECTORY [--offline]
  canopy-gateway migration verify --bundle DIRECTORY
  canopy-gateway migration import --bundle DIRECTORY --offline
  canopy-gateway migration inspect-links
  canopy-gateway migration cutover start|resume|status|abort --config FILE
  canopy-gateway migration cutover-target
  canopy-gateway migration capacity
  canopy-gateway migration fence drain|status|commit|abort --run UUID

Export writes a private PostgreSQL archive and authenticated manifest to a new directory.
Use --offline for the final export after stopping the source gateway and blocking reconnection.
Verify checks the manifest and archive with the existing CANOPY_SECRETS_KEY.
Import restores to an empty dedicated database. Keep the destination gateway stopped
and prevent reconnection throughout the operation. See the deployment guide for cutover.
Inspect-links reports source-owned records, linked computers and pending work.
Cutover start prepares the destination and performs an isolated trial restore.
Cutover resume drains and permanently commits the source before activating the target.
Cutover-target reads a cutover protocol request from stdin over authenticated SSH.`;

/** Operator-only commands. This entry point starts no gateway services. */
export async function migrationCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    console.log(USAGE);

    return 0;
  }

  const [action, ...rest] = args;

  try {
    if (action === "cutover-target" && rest.length === 0) {
      const response = await handleCutoverTarget(env, Bun.stdin.stream());
      await Bun.write(Bun.stdout, JSON.stringify(response) + "\n");

      return 0;
    }

    if (action === "cutover") {
      const options = cutoverOptions(rest);

      if (!options) {
        console.error(USAGE);

        return 64;
      }

      console.log(JSON.stringify(await runCutoverSource(options.config, env, options.operation), null, 2));

      return 0;
    }

    if (action === "capacity" && rest.length === 0) {
      console.log(JSON.stringify(await inspectDatabaseCapacity(env)));

      return 0;
    }

    if (action === "fence") {
      const [operation, ...options] = rest;
      const runId = fenceRun(options);

      if (
        !runId ||
        (operation !== "drain" && operation !== "status" && operation !== "commit" && operation !== "abort")
      ) {
        console.error(USAGE);

        return 64;
      }

      if (operation === "drain") await requestDrain(env, runId);
      else if (operation === "commit") await commitSourceFence(env, runId);
      else if (operation === "abort") await abortFence(env, runId);

      const fence = await readFence(env);

      if (fence && fence.operationId !== runId.toLowerCase())
        throw new CutoverError("The source database is fenced by a different operation.");
      console.log(JSON.stringify({ runId, fence: fence?.state ?? null }));

      return 0;
    }

    if (action === "inspect-links" && rest.length === 0) {
      console.log(JSON.stringify(await inspectLinks(env), null, 2));

      return 0;
    }

    const run = Match.value(action).pipe(
      Match.when("export", () => exportBundle),
      Match.when("verify", () => verifyBundle),
      Match.when("import", () => (environment: NodeJS.ProcessEnv, path: string) => importBundle(environment, path)),
      Match.orElse(() => undefined),
    );

    const options = run && bundleOptions(rest, action);

    if (!run || !options) {
      console.error(USAGE);

      return 64;
    }

    const manifest = await run(env, options.directory, options.offline);
    console.log(JSON.stringify({ action, ...manifest }, null, 2));

    return 0;
  } catch (error) {
    // I/O and driver failures may include environment, paths, or credentials.
    console.error(
      error instanceof MigrationBundleError || error instanceof DatabaseMigrationError || error instanceof CutoverError
        ? error.message
        : "Gateway migration command failed. Check the bundle, PostgreSQL tools, and database permissions.",
    );

    return 1;
  }
}

function bundleOptions(args: string[], action: string | undefined) {
  try {
    const { values } = parseArgs({
      args,
      options: { bundle: { type: "string" }, offline: { type: "boolean" } },
    });

    const offline = values.offline === true;

    if (values.bundle?.trim() && (action === "export" || offline === (action === "import")))
      return { directory: resolve(values.bundle), offline };
  } catch {
    // Print usage without repeating arbitrary input.
  }

  return undefined;
}

function cutoverOptions(args: string[]): { operation: SourceAction; config: string } | undefined {
  const [operation, ...rest] = args;

  if (operation !== "start" && operation !== "resume" && operation !== "status" && operation !== "abort") return;

  try {
    const { values } = parseArgs({ args: rest, options: { config: { type: "string" } } });

    if (values.config?.trim()) return { operation, config: resolve(values.config) };
  } catch {
    // Print usage without repeating arbitrary input.
  }

  return undefined;
}

function fenceRun(args: string[]) {
  try {
    const { values } = parseArgs({ args, options: { run: { type: "string" } } });

    if (values.run && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(values.run)) return values.run;
  } catch {
    // Print usage without repeating arbitrary input.
  }

  return undefined;
}
