import type { GatewayLink } from "../gateway-link/index.ts";
import { applyAck } from "../gateway-link/index.ts";
import type { WorkerHost } from "./host.ts";
import type { ManagedRuntime } from "effect";
import type { Journal } from "../journal/index.ts";
import type { NetworkRoutes } from "@canopy/contracts";
import { workerDiagnostics } from "../diagnostics/worker.ts";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { LogPullSource } from "@canopy/logs";
import { workerTracing } from "../diagnostics/tracing.ts";

export interface SessionEnd {
  /** Set when the gateway asked to reconnect later (Drain). */
  readonly drainDelayMs?: number;
}

/** Serves one gateway link until it ends: config, commands, interaction answers, acks, drain. */
export async function serveLink(
  link: GatewayLink,
  host: WorkerHost,
  runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>,
  log: (message: string) => void = () => {},
  networkRoutes?: (routes: NetworkRoutes) => Promise<void>,
  logs?: LogPullSource,
): Promise<SessionEnd> {
  host.attach(link);
  let drainDelayMs: number | undefined;

  try {
    for await (const message of link.messages) {
      switch (message.payload.case) {
        case "diagnosticsTraceCommand":
          link.send({ case: "diagnosticsTraceReply", value: workerTracing.receive(message.payload.value) });
          break;
        case "diagnosticsLogCommand": {
          const command = message.payload.value;

          // Explicit exporter work yields independently of transcript ACK and heartbeat handling.
          if (logs)
            void logs
              .receive(command)
              .then((part) => {
                link.send({
                  case: "diagnosticsLogReply",
                  value: { session: command.session, requestId: command.requestId, part },
                });
              })
              .catch(() => {
                try {
                  link.send({
                    case: "diagnosticsLogReply",
                    value: {
                      session: command.session,
                      requestId: command.requestId,
                      part: create(ui.DiagnosticsLogPartSchema, { end: true }),
                    },
                  });
                } catch {
                  /* Link closed. No journal/outbox retry for log payloads. */
                }
              });
          break;
        }

        case "networkRoutes":
          // Probe concurrently: commands, heartbeats and journal acks stay on the working link.
          void networkRoutes?.(message.payload.value);
          break;
        case "agentEnvironment":
          host.environment.apply(message.payload.value);
          break;
        case "threadSecretDelivery":
          link.send({ case: "threadSecretReceipt", value: host.secrets.apply(message.payload.value) });
          break;
        case "config": {
          const report = await host.applyConfig(message.payload.value);
          link.send({ case: "configApplied", value: report });
          log(
            `config v${message.payload.value.version} ${report.applied ? "applied" : "rejected"} (${report.issues?.length ?? 0} issue(s))`,
          );
          break;
        }

        case "command": {
          const command = message.payload.value;
          const tracing = workerTracing.command(command.kind.case);
          // Commands run concurrently (a long turn must not block an interrupt); results go back when ready.
          void host.handleCommand(command).then((result) => {
            tracing?.(!result?.ok);

            if (!result) return; // the worker is stopping: redelivered to the next process

            try {
              link.send({ case: "commandResult", value: result });
            } catch {
              // link closed: the gateway redelivers, the journal answers with the remembered result
            }
          });
          break;
        }

        case "interactionResponse":
          host.handleInteractionResponse(message.payload.value);
          break;
        case "agentToolResult":
          host.handleAgentToolResult(message.payload.value);
          break;
        case "blobChunk":
          host.handleBlobChunk(message.payload.value);
          break;
        case "eventAck":
          workerDiagnostics.record(106, await runtime.runPromise(applyAck(message.payload.value)));
          break;
        case "drain":
          drainDelayMs = message.payload.value.reconnectAfterMs;
          log(`gateway draining (${message.payload.value.reason}), reconnecting in ${drainDelayMs} ms`);
          break;
        default:
          break;
      }
    }
  } finally {
    workerTracing.close();
    await logs?.close();
    host.detach(link);
  }

  return drainDelayMs === undefined ? {} : { drainDelayMs };
}
