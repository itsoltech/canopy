import { createInterface } from "node:readline";
import { DesktopRuntime, type RuntimePaths, type Secrets } from "./runtime/runtime.ts";

// stdout is a private protocol pipe. Sidecar stdout/stderr only goes to redacted files.
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
let runtime: DesktopRuntime | undefined;
let ending = false;
let queue = Promise.resolve();
async function stop() {
  if (ending) return;
  ending = true;
  // Bound cleanup even when a startup/enrollment operation has not settled yet.
  const deadline = setTimeout(() => { runtime?.killOwned(); process.exit(1); }, 30_000);
  runtime?.cancelStartup();
  await queue.catch(() => {});
  await runtime?.stop();
  clearTimeout(deadline);
  process.exit(0);
}
process.once("exit", () => runtime?.killOwned());
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
const lines = createInterface({ input: process.stdin });
lines.once("close", () => void stop()); // Electron died or closed its pipe: no orphan services.
lines.on("line", (line) => {
  queue = queue.then(async () => {
    let id: number | undefined;
    try {
      const request = JSON.parse(line) as { id: number; action: string; directory: string; paths: RuntimePaths; secrets: Secrets; configuration: unknown; state: string };
      id = request.id;
      if (ending) throw new Error("Desktop is stopping");
      if (request.action === "initialize" && !runtime) {
        runtime = new DesktopRuntime(request.directory, request.paths, request.secrets, (status) => send({ event: "status", status }));
        const origin = await runtime.initialize(false);
        send({ id, result: { origin, status: runtime.status } });
      } else if (request.action === "restore" && runtime) {
        await runtime.restore();
        send({ id, result: { status: runtime.status } });
      } else if (request.action === "configure" && runtime) {
        await runtime.configure(request.configuration);
        send({ id, result: { pids: runtime.pids } });
      } else if (request.action === "presence" && runtime) {
        await runtime.presence(request.state);
        send({ id, result: {} });
      } else throw new Error("Invalid desktop controller request");
    } catch (error) { send({ id, error: runtime?.logs.redact(error instanceof Error ? error.message : "Desktop operation failed") ?? "Desktop startup failed" }); }
  });
});
