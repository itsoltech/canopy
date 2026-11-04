import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { threadLifecycle, type ThreadLifecycle } from "./thread-lifecycle.ts";
import { threadSecretsStore, type ThreadSecretsStore } from "./thread-secrets.ts";
import { connectorStore } from "../connectors/store.ts";
import { workerStore, type WorkerStore } from "./workers-store.ts";
import { workerConfigStore, type WorkerConfigStore } from "./worker-config-store.ts";
import { projectStore, type ProjectStore } from "./projects-store.ts";
import { threadStore, type ThreadStore } from "./threads-store.ts";
import { threadCreation } from "./thread-create.ts";
import { turnStore, type TurnStore } from "./turns-store.ts";
import { threadSnapshot, type ThreadSnapshotStore } from "./thread-snapshot.ts";
import { outboxStore, type OutboxStore } from "./outbox.ts";
import { interactionStore, type InteractionStore } from "./interactions-store.ts";
import { worktreeStore, type WorktreeStore } from "./worktrees.ts";
import { worktreeLifecycleStore } from "./worktree-lifecycle.ts";

/**
 * Gateway data access (PostgreSQL). One service, grouped by concern; every query casts uuid
 * parameters explicitly because the driver sends strings as text.
 */

export { Invalid, NotFound } from "./errors.ts";

export type { InteractionResponse, InteractionRow, OutboxRow, ThreadRow, TurnRow } from "./rows.ts";

export {
  permissionModeName,
  permissionModeOf,
  toInteraction,
  toUiSender,
  toUiThread,
  toUiTurn,
  type SenderColumns,
} from "./ui-mappers.ts";

export class GatewayStore extends Context.Service<
  GatewayStore,
  ThreadSecretsStore & { connectors: ReturnType<typeof connectorStore> } & WorkerStore &
    WorkerConfigStore &
    ProjectStore &
    ThreadStore &
    TurnStore &
    ThreadSnapshotStore &
    OutboxStore &
    InteractionStore &
    WorktreeStore &
    ReturnType<typeof worktreeLifecycleStore> &
    ThreadLifecycle
>()("canopy/gateway/GatewayStore") {
  static readonly layer = (secretsKey: Buffer) =>
    Layer.effect(
      GatewayStore,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const store: GatewayStore["Service"] = {
          connectors: connectorStore(sql, secretsKey),
          ...threadSecretsStore(sql, secretsKey),
          ...threadLifecycle(sql, (input) => store.enqueueCommand(input)),
          ...workerStore(sql),
          ...workerConfigStore(sql, secretsKey),
          ...projectStore(sql),
          ...threadCreation(sql, () => store),
          ...threadStore(sql),
          ...turnStore(sql),
          ...threadSnapshot(sql, () => store),
          ...outboxStore(sql),
          ...interactionStore(sql, () => store),
          ...worktreeStore(sql),
          ...worktreeLifecycleStore(sql),
        };

        return GatewayStore.of(store);
      }),
    );
}
