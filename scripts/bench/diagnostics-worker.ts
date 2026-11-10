import { openGatewayLink } from "../../apps/worker/src/gateway-link/link.ts";
import { WorkerState } from "@canopy/contracts";

const baseUrl = process.env["CANOPY_BENCH_GATEWAY_URL"];
const credential = process.env["CANOPY_BENCH_WORKER_CREDENTIAL"];
const workerId = process.env["CANOPY_BENCH_WORKER_ID"];

if (!baseUrl || !credential || !workerId) throw new Error("Private benchmark worker configuration is required");

const link = await openGatewayLink({
  baseUrl,
  credential,
  hello: { workerId, journalId: crypto.randomUUID(), state: WorkerState.ACTIVE, capabilities: ["diagnostics_v1"] },
});

const heartbeat = setInterval(() => link.send({ case: "heartbeat", value: { state: WorkerState.ACTIVE } }), 15_000);

process.on("message", () => {
  clearInterval(heartbeat);
  link.close();
});

process.send?.({ ready: true });

try {
  for await (const { payload } of link.messages) {
    if (payload.case === "config")
      link.send({ case: "configApplied", value: { version: payload.value.version, applied: true } });

    if (payload.case === "command")
      link.send({ case: "commandResult", value: { commandId: payload.value.commandId, ok: true } });
  }
} finally {
  clearInterval(heartbeat);
  process.disconnect?.();
}
