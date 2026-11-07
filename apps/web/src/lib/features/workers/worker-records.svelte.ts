import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import { awayReason, workerPresence } from "#lib/features/computers/computers.ts";
import { computerName } from "@canopy/domain/computer-presence";
import type { SelectOption } from "#lib/shared/ui/listbox.ts";

/** A worker of another computer in Settings → Workers: live when its home answers, its record otherwise. */
export type LinkedWorker = { worker: ui.Worker; record: ui.WorkerRecord; readOnly: string };

export type WorkerComputer = { nodeId: string; name: string; readOnly: string; workers: LinkedWorker[] };

const RELOAD = new Set(["workerRecordsChanged", "worker", "workerRemoved", "computer", "computerRemoved"]);

/** The last known worker of a record, for a home that is not answering now. */
function recordedWorker(record: ui.WorkerRecord): ui.Worker {
  return create(ui.WorkerSchema, {
    id: record.workerId,
    name: record.name,
    hostname: record.hostname,
    os: record.os,
    arch: record.arch,
    nodeId: record.nodeId,
    online: false,
    ...(record.cliUpdateCheckMinutes !== undefined && { cliUpdateCheckMinutes: record.cliUpdateCheckMinutes }),
  });
}

/**
 * Workers of the other computers that share configuration (docs/linked-computers.md, stage 6). Only the home
 * changes them; this computer reads its copy, so an offline computer's workers stay visible and read-only.
 */
export class WorkerRecords {
  records = $state.raw<ui.WorkerRecord[]>([]);
  loaded = $state(false);
  error = $state("");
  #sequence = 0;

  constructor(private readonly overview: OverviewState) {}

  async reload(): Promise<void> {
    const sequence = ++this.#sequence;

    try {
      const result = decode(ui.ListWorkerRecordsResponseSchema, await requestJson("GET", "/api/workers/records"));

      if (sequence !== this.#sequence) return;
      this.records = result.records;
      this.error = "";
    } catch (cause) {
      if (sequence === this.#sequence)
        this.error = cause instanceof Error ? cause.message : "Could not load workers of linked computers.";
    } finally {
      if (sequence === this.#sequence) this.loaded = true;
    }
  }

  record(workerId: string): ui.WorkerRecord | undefined {
    return this.records.find((r) => r.workerId === workerId);
  }

  /** Settings include only workers whose home shares its configuration records. */
  workers: ui.Worker[] = $derived.by(() => [
    ...this.overview.ownWorkers,
    ...this.computers.flatMap((group) => group.workers.map((entry) => entry.worker)),
  ]);

  /** Execution pickers also include linked computers outside the configuration group. */
  available: ui.Worker[] = $derived.by(() => [
    ...this.workers,
    ...this.overview.workers.filter((w) => !this.workers.some((known) => known.id === w.id)),
  ]);

  name(worker: ui.Worker): string {
    return (
      this.record(worker.id)?.computerName ||
      (worker.nodeId ? computerName(this.overview.computer(worker.nodeId)) : "This computer")
    );
  }

  readOnly(workerId: string): string {
    const worker = this.overview.worker(workerId);

    return (
      this.record(workerId)?.readOnlyReason ??
      (worker?.nodeId ? "Manage this worker on its own computer. Configuration is not shared." : "")
    );
  }

  options(workers: readonly ui.Worker[] = this.workers, execution = false): SelectOption[] {
    return [...workers]
      .sort(
        (a, b) =>
          Number(!!a.nodeId) - Number(!!b.nodeId) ||
          this.name(a).localeCompare(this.name(b)) ||
          a.name.localeCompare(b.name),
      )
      .map((worker) => {
        const presence = workerPresence(worker, this.overview.computer(worker.nodeId));

        const reason = execution
          ? worker.nodeId && awayReason(this.overview.computer(worker.nodeId))
          : this.readOnly(worker.id);

        return {
          value: worker.id,
          label: `${worker.name} · ${this.name(worker)}`,
          group: this.name(worker),
          description: reason || presence.status,
          disabled: execution ? !!reason : false,
        };
      });
  }

  instance(instance: ui.ProviderInstance): ui.ProviderInstance {
    return create(ui.ProviderInstanceSchema, {
      ...instance,
      workers: [
        ...instance.workers,
        ...this.records.map((record) => {
          const on = record.instances.find((i) => i.harness === instance.harness && i.id === instance.id);

          const live = this.overview
            .worker(record.workerId)
            ?.providerInstances.find((i) => i.harness === instance.harness && i.id === instance.id);

          if (live?.status) return create(ui.InstanceOnWorkerSchema, { ...live.status, workerId: record.workerId });

          return create(ui.InstanceOnWorkerSchema, {
            workerId: record.workerId,
            enabled: live?.enabled ?? on?.enabled ?? instance.allWorkers,
            explicit: on?.enabled !== undefined,
            detail: `Status from ${record.computerName || record.name} unavailable`,
            overrides: { apiKeySet: on?.keySet ?? false },
          });
        }),
      ],
    });
  }

  linked(record: ui.WorkerRecord): LinkedWorker {
    const live = this.overview.worker(record.workerId);
    const readOnly = record.readOnlyReason;

    return { worker: live ?? recordedWorker(record), record, readOnly };
  }

  /** Other computers in name order, each with its workers. */
  computers: WorkerComputer[] = $derived.by(() => {
    const groups = new Map<string, WorkerComputer>();

    const records = [
      ...this.records,
      ...this.overview.workers
        .filter((worker) => worker.nodeId && !this.record(worker.id))
        .map((worker) =>
          create(ui.WorkerRecordSchema, {
            workerId: worker.id,
            nodeId: worker.nodeId,
            name: worker.name,
            computerName: computerName(this.overview.computer(worker.nodeId)),
            readOnlyReason: awayReason(this.overview.computer(worker.nodeId)) ?? this.readOnly(worker.id),
          }),
        ),
    ];

    for (const record of records) {
      const group = groups.get(record.nodeId) ?? {
        nodeId: record.nodeId,
        name: record.computerName,
        readOnly: record.readOnlyReason,
        workers: [],
      };

      group.workers.push(this.linked(record));
      groups.set(record.nodeId, group);
    }

    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** Records that reload with the overview stream: their changes, workers and linked computers. */
export function workerRecords(overview: OverviewState): WorkerRecords {
  const records = new WorkerRecords(overview);

  $effect(() => {
    void records.reload();

    return overview.subscribe((update) => {
      if (RELOAD.has(update.change.case ?? "")) void records.reload();
    });
  });

  $effect(() => {
    if (overview.resyncs > 0) void records.reload();
  });

  return records;
}
