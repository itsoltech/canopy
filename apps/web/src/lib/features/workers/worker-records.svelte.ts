import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { sharedRead, type SharedRead } from "#lib/shared/queries.svelte.ts";
import { awayReason, workerPresence } from "#lib/features/computers/computers.ts";
import { computerName } from "@canopy/domain/computer-presence";
import type { SelectOption } from "#lib/shared/ui/listbox.ts";

/** A worker of another computer in Settings → Workers: live when its home answers, its record otherwise. */
export type LinkedWorker = { worker: ui.Worker; record: ui.WorkerRecord; readOnly: string };

export type WorkerComputer = { nodeId: string; name: string; readOnly: string; workers: LinkedWorker[] };

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
  constructor(
    private readonly overview: OverviewState,
    private readonly read: SharedRead<ui.ListWorkerRecordsResponse>,
  ) {}

  get records(): ui.WorkerRecord[] {
    return this.read.data?.records ?? [];
  }

  get loaded(): boolean {
    const { loaded, error } = this.read.snapshot;

    return loaded || !!error;
  }

  get error(): string {
    return this.read.snapshot.error ? "Could not load workers of linked computers." : "";
  }

  async reload(): Promise<void> {
    await this.read.reload().catch(() => {});
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

/**
 * The tab's one copy of the records: every page and picker shares it. It reads again when records change, a
 * linked computer changes or leaves, and after a gap in the stream (AppShell), never per worker report.
 */
export function workerRecords(overview: OverviewState): WorkerRecords {
  return new WorkerRecords(
    overview,
    sharedRead("ListWorkerRecords", ui.ListWorkerRecordsResponseSchema, "/api/workers/records"),
  );
}
