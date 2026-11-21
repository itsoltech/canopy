import queueReadIndexes from "./0103_queue_read_indexes.sql" with { type: "text" };
import retentionIndexes from "./0105_retention_indexes.sql" with { type: "text" };
import pollingIndexes from "./0106_polling_indexes.sql" with { type: "text" };
import lifecycleReadIndexes from "./0107_lifecycle_read_indexes.sql" with { type: "text" };
import secretQueueIndexes from "./0109_secret_queue_indexes.sql" with { type: "text" };
import { indexTasks, runIndexTasks } from "./index-tasks.ts";

const deferredIndexes = indexTasks(
  [queueReadIndexes, retentionIndexes, pollingIndexes, lifecycleReadIndexes, secretQueueIndexes].join("\n"),
).filter((task) => task.name !== "worker_commands_redelivery");

export const reconcileDeferredIndexes = (concurrent: boolean) =>
  runIndexTasks(deferredIndexes, concurrent, ["worker_commands_open", "worker_commands_redelivery"]);
