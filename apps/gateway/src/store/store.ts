import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { threadLifecycle, type ThreadLifecycle } from "./thread-lifecycle.ts";
import { threadSecretsStore, type ThreadSecretsStore } from "./thread-secrets.ts";
import { connectorStore } from "../connectors/store.ts";
import { githubStore } from "../github/store.ts";
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
import { workspaceCopyStore } from "./workspace-copy.ts";
import { queryMethods } from "../diagnostics/query-context.ts";
import { rewindStore, type RewindStore } from "./rewinds.ts";

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
  ThreadSecretsStore & {
    connectors: ReturnType<typeof connectorStore>;
    github: ReturnType<typeof githubStore>;
  } & WorkerStore &
    WorkerConfigStore &
    ProjectStore &
    ThreadStore &
    TurnStore &
    ThreadSnapshotStore &
    OutboxStore &
    InteractionStore &
    WorktreeStore &
    ReturnType<typeof worktreeLifecycleStore> &
    ThreadLifecycle &
    ReturnType<typeof workspaceCopyStore> &
    RewindStore
>()("canopy/gateway/GatewayStore") {
  static readonly layer = (secretsKey: Buffer) =>
    Layer.effect(
      GatewayStore,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const store: GatewayStore["Service"] = {
          connectors: queryMethods("connectors.store", connectorStore(sql, secretsKey)),
          github: queryMethods("github.accounts", githubStore(sql, secretsKey)),
          ...queryMethods("secrets.store", threadSecretsStore(sql, secretsKey)),
          ...queryMethods(
            "threads.lifecycle",
            threadLifecycle(sql, (input) => store.enqueueCommand(input)),
          ),
          ...queryMethods("workers.store", workerStore(sql)),
          ...queryMethods("settings.store", workerConfigStore(sql, secretsKey)),
          ...queryMethods("projects.store", projectStore(sql)),
          ...queryMethods(
            "threads.create",
            threadCreation(sql, () => store),
          ),
          ...queryMethods("threads.metadata", threadStore(sql)),
          ...queryMethods("turns.store", turnStore(sql)),
          ...queryMethods(
            "events.history",
            threadSnapshot(sql, () => store),
          ),
          ...queryMethods("commands.write", outboxStore(sql)),
          ...queryMethods(
            "threads.lifecycle",
            rewindStore(sql, () => store),
          ),
          ...queryMethods(
            "interactions.store",
            interactionStore(sql, () => store),
          ),
          ...queryMethods("worktrees.store", worktreeStore(sql)),
          ...queryMethods("worktrees.store", worktreeLifecycleStore(sql)),
          ...queryMethods("worktrees.store", workspaceCopyStore(sql)),
        };

        return GatewayStore.of(store);
      }),
    );
}
