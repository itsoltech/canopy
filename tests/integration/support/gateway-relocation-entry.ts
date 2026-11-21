import { lstat, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Option, Schema } from "effect";
import { decodeTargetState } from "../../../apps/gateway/src/migration/cutover-protocol.ts";

export const gatewayEntry = join(import.meta.dir, "../../../apps/gateway/src/main.ts");
export const relocationEntry = import.meta.path;
export const bun = [process.execPath, "--no-env-file"] as const;

export const gatewayCommand = [
  ...bun,
  "--preload",
  join(import.meta.dir, "gateway-relocation-loopback.ts"),
  gatewayEntry,
];

function hasFault(path: string) {
  return lstat(path).then(
    () => true,
    (error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;

      throw error;
    },
  );
}

/** ForceCommand accepts exactly the request made by the production SSH client. */
async function receiver(environment: string, faults: string) {
  if (process.env["SSH_ORIGINAL_COMMAND"] !== "canopy-gateway migration cutover-target") return 64;

  const env = parseEnv(await readFile(environment, "utf8"));

  const child = Bun.spawn([...gatewayCommand, "migration", "cutover-target"], {
    env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });

  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);

  if (code === 0 && (await dropIfArmed(faults, output))) return 1;
  await Bun.write(Bun.stdout, output);

  return code;
}

async function dropIfArmed(faults: string, output: string) {
  const phase = (() => {
    try {
      return decodeTargetState(output).phase;
    } catch {
      const join = Schema.decodeUnknownOption(
        Schema.fromJsonString(Schema.Struct({ phase: Schema.Literal("applied") })),
      )(output);

      return Option.getOrUndefined(join)?.phase;
    }
  })();

  if (!phase) return false;
  const path = join(faults, phase);

  if (!(await hasFault(path))) return false;
  await rename(path, path + ".dropped");

  return true;
}

/** Service hooks act on the fixture's private supervisor socket so the test owns and reaps the gateway children. */
async function service(socket: string, route: string) {
  const result = await fetch(`http://127.0.0.1/${route}`, {
    unix: socket,
    method: "POST",
    signal: AbortSignal.timeout(20_000),
  });

  await result.body?.cancel();

  return result.ok ? 0 : result.status === 409 ? 1 : 2;
}

if (import.meta.main) {
  const [mode, first, second] = Bun.argv.slice(2);

  if (!first || !second) process.exit(64);

  if (mode === "receiver") process.exit(await receiver(first, second));

  if (mode === "service") process.exit(await service(first, second));
  process.exit(64);
}
