import { ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { workerChoices, workerStatusLabel } from "@canopy/domain/worker-choices";
import { useWorkerPresence } from "./presence";
import { useOverview } from "../../state/overview";

/** Flat worker options shared by creation, scheduling, bot and default settings. */
export function useWorkerOptions() {
  const presence = useWorkerPresence();

  return (workers: readonly ui.Worker[], execution = true) =>
    workerChoices(workers, presence).map(({ worker, duplicate, computer, online, status, reason }) => ({
      value: worker.id,
      label: worker.name,
      suffix: duplicate ? computer : undefined,
      online,
      description: [
        workerStatusLabel(worker, status),
        reason ?? (execution && !online ? "Start this worker to use it." : undefined),
      ]
        .filter(Boolean)
        .join(" · "),
      disabled: execution && !online,
      keywords: computer,
    }));
}

/** Configuration records keep offline workers listed even without a live overview row. */
export function useWorkerRecordOptions(records: readonly ui.WorkerRecord[]) {
  const { workers } = useOverview();
  const options = useWorkerOptions();

  return options(
    records.map(
      (record) =>
        workers.find((w) => w.id === record.workerId) ??
        create(ui.WorkerSchema, {
          id: record.workerId,
          name: record.name,
          nodeId: record.nodeId,
          os: record.os,
        }),
    ),
    false,
  );
}
