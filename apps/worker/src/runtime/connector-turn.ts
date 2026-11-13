import { NoticeLevel, type ThreadSpec } from "@canopy/contracts";
import {
  ConnectorSessionCatalog,
  connectorSessionCatalog,
  connectorSessionNote,
} from "@canopy/domain/connector-session";
import { Schema } from "effect";
import { Journal } from "../journal/index.ts";
import type { HostContext } from "./host-context.ts";

export async function connectorTurn(ctx: HostContext, spec: ThreadSpec, turnId: string) {
  const run = ctx.state.options.runtime.runPromise.bind(ctx.state.options.runtime);
  const saved = await run(Journal.use((j) => j.connectorCatalog(spec.threadId)));
  const previous = saved ? Schema.decodeUnknownSync(Schema.fromJsonString(ConnectorSessionCatalog))(saved) : [];
  const next = connectorSessionCatalog(spec.connectorTools);
  const encoded = JSON.stringify(next);
  const changed = encoded !== saved;
  let ready = false;

  const record = async (code: string, message: string) => {
    const event = await run(
      Journal.use((j) =>
        j.append(spec.threadId, {
          turnId,
          body: { case: "notice", value: { level: NoticeLevel.INFO, code, message, dataJson: encoded } },
        }),
      ),
    );

    ctx.ops.publish(event);
  };

  return {
    connectorNote: connectorSessionNote(previous, next),
    connectorsReady: async () => {
      if (ready) return;

      if (changed) {
        await record("connectors_applied", "Connector tools updated");
        await run(Journal.use((j) => j.rememberConnectorCatalog(spec.threadId, encoded)));
      }

      ready = true;
    },
    failed: async () => {
      if (!ready)
        await record("connectors_failed", "The agent could not load connector tools. Send a new message to retry.");
    },
  };
}
