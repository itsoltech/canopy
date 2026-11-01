import { parseArgs } from "node:util";
import { ProviderProfileKind, DeviceLogin } from "@open-agents/contracts";
import { GatewayStore } from "./store/index.ts";
import { ensureDevUser, gatewayRuntime, migrateDatabase } from "./runtime.ts";

/**
 * Administration until the UI has these screens:
 *   bun apps/gateway/src/cli.ts worker add --name laptop --root /home/me/code \
 *     [--gateway-url https://agents.example.com] [--cliproxy-url URL --cliproxy-key-env VAR] [--model gpt-6.1-sol]
 * Prints the worker's local config (worker.json) to stdout; store it with chmod 600.
 */
const [area, action, ...rest] = Bun.argv.slice(2);
if (area !== "worker" || action !== "add") {
  console.error("usage: cli.ts worker add --name NAME --root PATH [--root PATH] [--gateway-url URL] [--cliproxy-url URL --cliproxy-key-env VAR]");
  process.exit(64);
}
const { values } = parseArgs({
  args: rest,
  options: {
    name: { type: "string" },
    root: { type: "string", multiple: true },
    "gateway-url": { type: "string", default: "http://127.0.0.1:7443" },
    "cliproxy-url": { type: "string" },
    "cliproxy-key-env": { type: "string" },
  },
  strict: true,
});
if (!values.name || !values.root?.length) {
  console.error("--name and at least one --root are required");
  process.exit(64);
}

const runtime = gatewayRuntime(Bun.env);
await migrateDatabase(runtime);
const userId = await ensureDevUser(runtime, Bun.env["OA_DEV_USER_EMAIL"] ?? "dev@localhost");
const { workerId, credential } = await runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: values.name!, ownerUserId: userId })));

// CLIProxyAPI key: read from an env var of this process (never a CLI argument), stored encrypted.
let profiles: { id: string; kind: ProviderProfileKind; baseUrl: string }[] = [];
const secretRefs: Record<string, string> = {};
if (values["cliproxy-url"]) {
  const keyEnv = values["cliproxy-key-env"] ?? "OA_CLIPROXYAPI_API_KEY";
  const key = Bun.env[keyEnv];
  if (!key) throw new Error(`${keyEnv} is not set`);
  const secretId = await runtime.runPromise(
    GatewayStore.use((s) => s.putSecret({ ownerUserId: userId, name: `cliproxyapi-${workerId.slice(-8)}`, plaintext: key, createdBy: userId })),
  );
  profiles = [{ id: "cliproxyapi", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: values["cliproxy-url"] }];
  secretRefs["cliproxyapi"] = secretId;
}
await runtime.runPromise(
  GatewayStore.use((s) =>
    s.setWorkerConfig(
      workerId,
      {
        allowedRoots: values.root!,
        // Both CLIs; the worker reports the ones it cannot find. With a proxy profile no device login is linked.
        codex: { enabled: true, ...(profiles.length > 0 && { deviceLogin: DeviceLogin.NONE }) },
        claude: { enabled: true, ...(profiles.length > 0 && { deviceLogin: DeviceLogin.NONE }) },
        profiles,
      },
      userId,
      secretRefs,
    ),
  ),
);
await runtime.dispose();
console.log(JSON.stringify({ gateway_url: values["gateway-url"], worker_id: workerId, credential }, null, 2));
