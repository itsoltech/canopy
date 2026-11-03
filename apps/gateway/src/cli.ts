import { parseArgs } from "node:util";
import { DeviceLogin } from "@canopy/contracts";
import { GatewayStore, InstanceStore } from "./store/index.ts";
import { ensureDevUser, gatewayRuntime, migrateDatabase } from "./runtime.ts";

/**
 * Administration until the UI has these screens:
 *   bun apps/gateway/src/cli.ts worker add --name laptop \
 *     [--gateway-url https://agents.example.com] [--cliproxy-url URL --cliproxy-key-env VAR] [--model gpt-6.1-sol]
 * Prints the worker's local config (worker.json) to stdout; store it with chmod 600.
 */
const [area, action, ...rest] = Bun.argv.slice(2);
if (area !== "worker" || action !== "add") {
  console.error("usage: cli.ts worker add --name NAME [--gateway-url URL] [--cliproxy-url URL --cliproxy-key-env VAR]");
  process.exit(64);
}
const { values } = parseArgs({
  args: rest,
  options: {
    name: { type: "string" },
    "gateway-url": { type: "string", default: "http://127.0.0.1:7443" },
    "cliproxy-url": { type: "string" },
    "cliproxy-key-env": { type: "string" },
  },
  strict: true,
});
if (!values.name) {
  console.error("--name is required");
  process.exit(64);
}

const runtime = gatewayRuntime(Bun.env);
await migrateDatabase(runtime);
const userId = await ensureDevUser(runtime, Bun.env["OA_DEV_USER_EMAIL"] ?? "dev@localhost");
const { workerId, credential } = await runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: values.name!, ownerUserId: userId })));

// CLIProxyAPI key: read from an env var of this process (never a CLI argument), stored encrypted.
let secretId: string | undefined;
if (values["cliproxy-url"]) {
  const keyEnv = values["cliproxy-key-env"] ?? "OA_CLIPROXYAPI_API_KEY";
  const key = Bun.env[keyEnv];
  if (!key) throw new Error(`${keyEnv} is not set`);
  secretId = await runtime.runPromise(
    GatewayStore.use((s) => s.putSecret({ ownerUserId: userId, name: `cliproxyapi-${workerId.slice(-8)}`, plaintext: key, createdBy: userId })),
  );
}
await runtime.runPromise(
  GatewayStore.use((s) =>
    s.setWorkerConfig(
      workerId,
      {
        // Both CLIs; the worker reports the ones it cannot find. With a proxy no device login is linked.
        codex: { enabled: true, ...(secretId && { deviceLogin: DeviceLogin.NONE }) },
        claude: { enabled: true, ...(secretId && { deviceLogin: DeviceLogin.NONE }) },
        grok: { enabled: true, ...(secretId && { deviceLogin: DeviceLogin.NONE }) },
      },
      userId,
    ),
  ),
);
// Global provider instances (docs/worker-config.md, section 9): the proxy as the "cliproxyapi" instance of both
// harnesses, enabled on this worker; then the worker's configuration gets its effective instances.
if (secretId) {
  const apiKey = { secretRef: secretId };
  await runtime.runPromise(InstanceStore.use((s) => s.registerEndpoint({ userId, workerId, baseUrl: values["cliproxy-url"]!, apiKey })));
}
await runtime.runPromise(InstanceStore.use((s) => s.sync(userId, [workerId])));
await runtime.dispose();
console.log(JSON.stringify({ gateway_url: values["gateway-url"], worker_id: workerId, credential }, null, 2));
