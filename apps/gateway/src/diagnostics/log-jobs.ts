import { create } from "@bufbuild/protobuf";
import { computerLink, ui } from "@canopy/contracts";
import { LOG_LIMITS, LogZip, logFileChunks, logJsonChunks, logChecksum } from "@canopy/logs";
import { Code, ConnectError } from "@connectrpc/connect";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayCore, GatewayCoreOptions } from "../core/core.ts";
import { HomeLogExport } from "./log-home.ts";
import { LogArchive } from "./log-archive.ts";
import { linkedMessage } from "../computers/remote.ts";
import { DIAGNOSTICS_LOGS } from "../computers/capabilities.ts";
import { actionQuery } from "./actions.ts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";

type Job = {
  value: ui.DiagnosticsLogsJob;
  request: ui.CollectDiagnosticsLogsRequest;
  abort: AbortController;
  directory: string;
  file: string;
  task: Promise<void>;
  release: () => void;
};

/** One owner job, two home readers, one store-only ZIP, no payload/failed-error rings in memory. */
export class DiagnosticsLogs {
  readonly enabled: boolean;
  readonly directory: string;
  readonly home: HomeLogExport;
  #job: Job | undefined;
  #initialised: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #downloads = 0;
  #starting = false;

  constructor(
    readonly core: GatewayCore,
    readonly options: GatewayCoreOptions,
  ) {
    this.enabled = options.logsDiagnosticsEnabled ?? true;
    this.directory = options.diagnosticsLogDirectory
      ? join(options.diagnosticsLogDirectory, "diagnostics-log-spool")
      : join(tmpdir(), `canopy-diagnostics-logs-${crypto.randomUUID()}`);
    this.home = new HomeLogExport(core, options, this.directory);
  }

  async initialise() {
    this.#initialised ??= rm(this.directory, { recursive: true, force: true })
      .then(() => mkdir(this.directory, { recursive: true, mode: 0o700 }))
      .then(() => {});
    await this.#initialised;
  }

  async collect(request: ui.CollectDiagnosticsLogsRequest, device = "") {
    if (this.#starting) throw new ConnectError("A log collection is already starting", Code.ResourceExhausted);
    this.#starting = true;

    try {
      return await this.#collect(request, device);
    } finally {
      this.#starting = false;
    }
  }

  async #collect(request: ui.CollectDiagnosticsLogsRequest, device: string) {
    if (!this.enabled) throw new ConnectError("Update to collect logs", Code.Unimplemented);

    if (
      !/^[a-f0-9-]{36}$/.test(request.actionId) ||
      ![1, 6, 24].includes(request.hours) ||
      !request.computerIds.length ||
      request.computerIds.length > 16 ||
      new Set(request.computerIds).size !== request.computerIds.length ||
      request.computerIds.some((id) => id !== "local" && !/^[a-f0-9]{64}$/.test(id))
    )
      throw new ConnectError("Choose up to 16 computers and a log range", Code.InvalidArgument);

    if (this.#job?.request.actionId === request.actionId) {
      if (JSON.stringify(this.#job.request) !== JSON.stringify(request))
        throw new ConnectError("This action already used another selection", Code.AlreadyExists);

      return create(ui.DiagnosticsLogsJobSchema, this.#job.value);
    }

    if (this.#job?.value.status === "collecting" || this.#downloads)
      throw new ConnectError("A log collection is already running", Code.ResourceExhausted);
    await this.expire();
    await this.initialise();
    const directory = join(this.directory, "coordinator");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const abort = new AbortController();
    const now = Date.now();

    const value = create(ui.DiagnosticsLogsJobSchema, {
      jobId: request.actionId,
      status: "collecting",
      createdAtMs: BigInt(now),
      expiresAtMs: BigInt(now + LOG_LIMITS.ttlMs),
      hours: request.hours,
      homes: request.computerIds.map((id, index) => ({
        computerId: id,
        alias: `Computer-${index + 1}`,
        status: "waiting",
      })),
    });

    const job: Job = {
      value,
      request: create(ui.CollectDiagnosticsLogsRequestSchema, request),
      abort,
      directory,
      file: join(directory, "logs.zip"),
      task: Promise.resolve(),
      release: () => {},
    };

    this.#job = job;

    if (device) job.release = this.core.mobile.track(device, abort);
    this.#timer = setTimeout(() => void this.expire(), LOG_LIMITS.ttlMs);
    this.#timer.unref();
    job.task = this.#run(job).catch(async () => {
      job.value.status = abort.signal.aborted ? "cancelled" : "unavailable";
      await rm(job.file, { force: true });
    });

    return create(ui.DiagnosticsLogsJobSchema, value);
  }

  get(id: string) {
    if (
      !this.#job ||
      id !== this.#job.value.jobId ||
      this.#job.value.expiresAtMs <= BigInt(Date.now()) ||
      this.#job.abort.signal.aborted
    )
      throw new ConnectError("Log collection expired. Collect logs again.", Code.NotFound);

    return create(ui.DiagnosticsLogsJobSchema, this.#job.value);
  }

  async cancel(id: string) {
    const value = this.get(id);
    await this.expire("cancelled");

    return create(ui.DiagnosticsLogsJobSchema, { ...value, status: "cancelled", bytes: 0n });
  }

  async *download(id: string, signal: AbortSignal) {
    const value = this.get(id);
    const job = this.#job!;

    if (!["done", "partial"].includes(value.status) || this.#downloads)
      throw new ConnectError("Wait for this log collection to finish", Code.FailedPrecondition);
    this.#downloads++;
    const combined = AbortSignal.any([signal, job.abort.signal]);
    let sequence = 0;

    try {
      for await (const data of logFileChunks(job.file, combined, 1024 * 1024)) {
        this.get(id);
        yield create(ui.DiagnosticsLogPartSchema, { sequence: sequence++, data, checksum: logChecksum(data) });
      }

      yield create(ui.DiagnosticsLogPartSchema, { sequence, end: true });
    } catch {
      combined.throwIfAborted();
      throw new ConnectError("Log download unavailable. Collect logs again.", Code.Unavailable);
    } finally {
      this.#downloads--;
    }
  }

  async attachment(id: string) {
    const value = this.get(id);
    const job = this.#job!;

    if (!["done", "partial"].includes(value.status) || value.bytes > 20n * 1024n * 1024n)
      throw new ConnectError("Choose fewer computers or a shorter range to attach logs", Code.ResourceExhausted);
    const chunks: Buffer[] = [];
    let bytes = 0;

    for await (const data of logFileChunks(job.file, job.abort.signal, 20 * 1024 * 1024)) {
      this.get(id);
      bytes += data.length;

      if (bytes > 20 * 1024 * 1024) throw new ConnectError("Log attachment limit reached", Code.ResourceExhausted);
      chunks.push(Buffer.from(data));
    }

    this.get(id);

    if (BigInt(bytes) !== value.bytes) throw new ConnectError("Log attachment ended early", Code.DataLoss);

    return Buffer.concat(chunks);
  }

  async revoke(node: string) {
    this.home.revoke(node);

    if (this.#job?.request.computerIds.includes(node)) await this.expire("revoked");
  }

  async expire(reason = "expired") {
    clearTimeout(this.#timer);
    const job = this.#job;
    this.#job = undefined;

    if (job) {
      job.abort.abort();
      await job.task;
      job.release();
      await rm(job.directory, { recursive: true, force: true });
      await this.audit(job.request.actionId, reason, job.request.hours, Number(job.value.bytes)).catch(() => {});
    }
  }

  async close() {
    await this.#initialised?.catch(() => {});
    this.home.close();
    await this.expire();
    await rm(this.directory, { recursive: true, force: true });
  }

  async audit(id: string, result: string, hours: number, bytes: number) {
    await actionQuery(
      this.core,
      `INSERT INTO audit_log(id,actor_user_id,action,target_type,details)
      VALUES(gen_random_uuid(),$1::uuid,'diagnostics.logs','computer',jsonb_build_object('action',$2::text,'result',$3::text,'hours',$4::int,'bytes',$5::bigint))`,
      [this.options.userId, id, result, String(hours), String(bytes)],
    );
  }

  async #run(job: Job) {
    await this.audit(job.request.actionId, "start", job.request.hours, 0);
    const zip = await LogZip.create(job.file);
    const archive = new LogArchive(zip);
    const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(180_000)]);
    let index = 0;

    try {
      const run = async () => {
        while (index < job.value.homes.length) {
          const home = job.value.homes[index++]!;
          home.status = "collecting";
          const budget = Math.min(LOG_LIMITS.home, Math.floor(LOG_LIMITS.action / job.value.homes.length));

          const input = create(ui.DiagnosticsHomeLogsRequestSchema, {
            actionId: job.request.actionId,
            hours: job.request.hours,
            includeLegacy: job.request.includeLegacy,
            aliasHome: job.request.aliasHome,
            budgetBytes: budget,
          });

          try {
            await archive.home(home.alias, this.#stream(home.computerId, input, signal), home, budget, signal);
          } catch (error) {
            home.status =
              error instanceof ConnectError && error.code === Code.PermissionDenied
                ? "not_permitted"
                : error instanceof ConnectError && error.code === Code.Unimplemented
                  ? "unsupported"
                  : signal.aborted
                    ? "timed_out"
                    : "offline";
          }
        }
      };

      await Promise.all([run(), run()]);
      signal.throwIfAborted();

      const manifest = {
        schema: 1,
        version: CANOPY_VERSION,
        collectedAt: new Date().toISOString(),
        hours: job.request.hours,
        note: "Only recognised event templates are exported. Unknown payloads, SQL, paths, hosts and names are omitted. Records are newest first.",
        computers: job.value.homes.map((home) => ({
          alias: home.alias,
          status: home.status,
          bytes: String(home.bytes),
          sources: home.sources.map((source) => ({
            source: source.source,
            worker: source.worker,
            status: source.status,
            bytes: String(source.bytes),
            records: String(source.records),
            omittedRecords: String(source.omittedRecords),
            omittedBytes: String(source.omittedBytes),
            redactedRecords: String(source.redactedRecords),
            firstAtMs: String(source.firstAtMs),
            lastAtMs: String(source.lastAtMs),
            legacy: source.legacy,
            rotationVerified: source.rotationVerified,
          })),
        })),
      };

      await zip.add("manifest.json", logJsonChunks(manifest), signal);
      await zip.finish();
      job.value.bytes = BigInt(zip.bytes);
      job.value.status = job.value.homes.every((home) => home.status === "done") ? "done" : "partial";
      await this.audit(job.request.actionId, job.value.status, job.request.hours, zip.bytes);
    } finally {
      await zip.close();
    }
  }

  async *#stream(node: string, request: ui.DiagnosticsHomeLogsRequest, signal: AbortSignal) {
    if (node === (this.core.computers?.hello().nodeId ?? "local")) {
      yield* this.home.stream(request, "local", signal);

      return;
    }

    const host = this.core.computers;
    const peer = await host?.store.computer(node);

    if (!host || !peer || !host.canCall(node)) throw new ConnectError("Computer is offline", Code.Unavailable);

    if (!host.capabilities(node).includes(DIAGNOSTICS_LOGS))
      throw new ConnectError("Update to collect logs", Code.Unimplemented);

    for await (const part of host.remote(
      node,
      computerLink.DiagnosticsService.method.collectHomeDiagnosticsLogs,
      request,
      signal,
    ))
      yield linkedMessage(ui.DiagnosticsLogPartSchema, part);
  }
}
