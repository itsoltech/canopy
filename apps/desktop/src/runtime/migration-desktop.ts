import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopMigrationApproval, DesktopMigrationTarget } from "@canopy/ui/desktop";
import { pinnedOrigins, routedPinnedTransport } from "@canopy/transport";
import { ui } from "@canopy/contracts";
import { createClient } from "@connectrpc/connect";
import type { DesktopClientCredential } from "../remote-client.ts";
import { remoteWorkerDirectory } from "../remote-client.ts";
import { MigrationSource, MigrationSourceError, migrationEnvironment, migrationTools } from "./migration-source.ts";
import { migrationSshTarget } from "./migration-ssh.ts";
import { desktopMigrationTarget } from "./migration-target.ts";
import { MigrationJournalFile, sourceFenced, type MigrationJournal } from "./migration-state.ts";
import { requireApproval } from "./migration-approval.ts";
import { migrationStatus } from "./migration-status.ts";
import { handoffDesktopWorker } from "./migration-worker.ts";
import { serviceEnvironment } from "./config.ts";
import type { DesktopRuntime } from "./runtime.ts";
import { until } from "./process.ts";

type Device = NonNullable<MigrationJournal["device"]>;

type Target = ReturnType<typeof desktopMigrationTarget>;

class MigrationMessage extends Error {}

const statusMessages = {
  prepare: "Could not complete the trial. Check the server’s migration setup and SSH access, then try again.",
  activate: "Could not confirm the cutover. Open recovery to check the source and destination.",
  recover: "Could not continue the migration. Check the destination and try recovery again.",
  abort: "Could not confirm that the migration was aborted. The source remains in its current state.",
  complete:
    "The destination is active. Could not start the Desktop connection and original worker. Try recovery again.",
};

export class DesktopGatewayMigration {
  private readonly journal: MigrationJournalFile;
  private readonly source: MigrationSource;
  private readonly env = serviceEnvironment();
  private readonly aborter = new AbortController();
  private error: string | undefined;
  private drainingGateway: { exited: Promise<number | null>; env: NodeJS.ProcessEnv } | undefined;
  constructor(
    private readonly runtime: DesktopRuntime,
    private readonly secretsKey: string,
  ) {
    this.journal = new MigrationJournalFile(runtime.directory);
    this.source = new MigrationSource(runtime.directory, runtime.paths, this.signal);
  }
  stop() {
    this.aborter.abort();
  }
  pending() {
    const operation = this.journal.read();

    return operation?.phase === "completed" ? undefined : operation;
  }
  startupHeld() {
    return sourceFenced(this.pending());
  }
  status() {
    return migrationStatus(this.journal.read(), this.error);
  }
  private async run(action: keyof typeof statusMessages, use: () => Promise<void>) {
    this.error = undefined;

    try {
      await use();
    } catch (error) {
      this.error =
        error instanceof MigrationMessage || error instanceof MigrationSourceError
          ? error.message
          : statusMessages[action];
      this.runtime.logs.write("desktop", `Gateway migration ${action}: ${this.error}`);
    }

    return this.status();
  }
  private get signal() {
    return this.aborter.signal;
  }
  private target(operation: MigrationJournal) {
    return desktopMigrationTarget(operation, { ...this.env, SSH_AUTH_SOCK: process.env["SSH_AUTH_SOCK"] }, this.signal);
  }
  private async database(offline: boolean) {
    const database = await this.runtime.migrationDatabase(offline, this.signal);

    return migrationEnvironment(database, this.env, this.secretsKey);
  }
  prepare(input: DesktopMigrationTarget) {
    return this.run("prepare", async () => {
      if (this.journal.read()) throw new MigrationMessage("Finish the existing migration first.");

      if (this.runtime.status.mode !== "local" || this.runtime.status.phase !== "running")
        throw new MigrationMessage("Start this app in Local mode before preparing a migration.");

      const operation = this.journal.save({
        version: 1,
        runId: randomUUID(),
        kind: input.kind,
        target: migrationSshTarget(input.invitation),
        phase: "preparing",
      });

      await this.trial(operation);
    });
  }
  private async trial(operation: MigrationJournal) {
    const started = performance.now();
    const database = await this.runtime.migrationDatabase(false, this.signal);
    const env = migrationEnvironment(database, this.env, this.secretsKey);
    await migrationTools(env, database.major, this.signal);
    const capacity = await this.source.capacity(env);

    const target = this.target(operation);

    const peers = (await this.runtime.client().getComputers({})).peers.map((peer) => ({
      nodeId: peer.nodeId,
      name: peer.displayName || peer.name,
      online: peer.status === "connected",
    }));

    const prior = await target.status();

    if (operation.kind === "move" && prior.phase === "absent") await target.prepare(capacity);
    const exporting = performance.now();
    const { path, manifest } = await this.source.stage(operation, env, false);
    const exportMs = Math.round(performance.now() - exporting);

    const result = completedTrial(prior, manifest.archiveSha256)
      ? prior
      : await target.upload(operation.kind === "move" ? "trial" : "join-prepare", this.secretsKey, path);

    const review = "review" in result ? result.review : undefined;
    const trial = "trial" in result ? result.trial : undefined;
    const digest = trial?.archiveSha256 ?? review?.archiveSha256;

    if (digest !== manifest.archiveSha256)
      throw new MigrationMessage("The destination did not verify the trial archive.");
    checkDestination(this.runtime.directory, result.routes);

    const preparation = {
      durationMs: Math.round(performance.now() - started),
      databaseBytes: capacity.databaseBytes,
      timings: {
        exportMs,
        ...(trial && { transferMs: trial.receiveMs, restoreMs: trial.restoreMs, verifyMs: trial.verifyMs }),
      },
      peers,
      ...(result.routes && { routes: result.routes.addresses }),
      ...(review && { review }),
    };

    this.journal.save({ ...operation, phase: "prepared", preparation });
    await this.source.clear(operation, true);
  }
  activate(device: Device, approval?: DesktopMigrationApproval, selectedPeerIds?: readonly string[]) {
    return this.run("activate", async () => {
      const operation = this.pending();

      if (!operation) throw new MigrationMessage("Prepare a migration first.");

      if (operation.phase === "prepared" && !approval) {
        const preparation =
          operation.preparation &&
          (operation.kind === "move" && selectedPeerIds
            ? {
                ...operation.preparation,
                selectedPeerIds: [...new Set(selectedPeerIds)].filter((id) =>
                  operation.preparation?.peers?.some((peer) => peer.nodeId === id),
                ),
              }
            : operation.preparation);

        await this.fence(
          this.journal.save({ ...operation, ...(preparation && { preparation }), device, phase: "draining" }),
        );
      } else if (operation.kind === "join" && ["fenced", "reviewing"].includes(operation.phase) && approval) {
        const confirmed = requireApproval(operation, approval);
        const env = await this.database(true);

        if (!operation.archiveSha256) throw new Error("Missing final join archive");
        await this.source.approvedSecrets(env, operation, operation.archiveSha256, confirmed.approvedSecretIds);
        await this.cutover(this.journal.save({ ...operation, approval: confirmed, phase: "committed" }));
      } else throw new MigrationMessage("Finish the pending step before activating this migration.");
    });
  }
  private async fence(operation: MigrationJournal) {
    if (!this.drainingGateway) {
      const env = await this.database(false).catch(() => undefined);

      const exited = env && this.runtime.quiesceLocalGateway();

      if (!env || !exited) {
        await this.runtime.stopLocalForMigration();
        await this.confirmDrain(operation, await this.database(true));

        return;
      }

      this.drainingGateway = { exited, env };
    }

    await this.source.fence(this.drainingGateway.env, operation, "drain");

    const deadline = new AbortController();
    const signal = AbortSignal.any([this.signal, deadline.signal]);

    try {
      const code = await Promise.race([this.drainingGateway.exited, delay(60_000, undefined, { signal })]);
      this.signal.throwIfAborted();

      if (code === undefined)
        throw new MigrationMessage("The gateway is still draining active work. Try recovery to check again.");

      if (code !== 0)
        throw new MigrationMessage("The gateway did not shut down cleanly. Abort and restart it locally.");
    } finally {
      deadline.abort();
    }

    await this.runtime.stopLocalForMigration();
    await this.confirmDrain(operation, await this.database(true));
  }
  private async confirmDrain(operation: MigrationJournal, env: NodeJS.ProcessEnv) {
    const fence = await this.source.fence(env, operation, "status");

    if (fence !== "drained")
      throw new MigrationMessage("The source could not confirm a clean drain. Abort this attempt before retrying.");

    if (!operation.preparation) throw new Error("Missing trial proof");
    const { review: _trialReview, ...preparation } = operation.preparation;

    await this.finalBundle(this.journal.save({ ...operation, phase: "fenced", preparation }), env);
  }
  private async finalBundle(operation: MigrationJournal, env: NodeJS.ProcessEnv) {
    const target = this.target(operation);
    const { path, manifest } = await this.source.stage(operation, env, true);
    const archiveSha256 = manifest.archiveSha256;
    const status = await target.status();

    const expected = operation.kind === "move" ? "restored" : "reviewed";

    const result =
      status.phase === expected && status.archiveSha256 === archiveSha256
        ? status
        : await target.upload(operation.kind === "join" ? "join-prepare" : "import", this.secretsKey, path);

    if (result.phase !== expected || result.archiveSha256 !== archiveSha256)
      throw new MigrationMessage("The destination did not confirm the final archive.");
    const review = "review" in result ? result.review : undefined;

    if (operation.kind === "join" && (!review || review.archiveSha256 !== archiveSha256))
      throw new MigrationMessage("The destination did not provide a review for the final archive.");
    const routes = result.routes;
    const profile = checkDestination(this.runtime.directory, routes);

    const finalized = this.journal.save({
      ...operation,
      archiveSha256,
      profile,
      ...(routes && { routes }),
      ...(operation.preparation && review && { preparation: { ...operation.preparation, review } }),
    });

    if (operation.kind === "move") {
      await this.cutover(this.journal.save({ ...finalized, phase: "committed" }));
    }
  }
  private async cutover(operation: MigrationJournal) {
    const { archiveSha256, device, profile } = operation;

    if (!archiveSha256 || !device || !profile) throw new Error("Incomplete migration record");
    const env = await this.database(true);
    const target = this.target(operation);
    const expected = operation.kind === "move" ? "active" : "applied";

    if ((await this.source.fence(env, operation, "commit")) !== "committed")
      throw new MigrationMessage("The source could not confirm its permanent startup fence.");
    this.signal.throwIfAborted();
    const status = await target.status();
    const result = status.phase === expected ? status : await this.activateTarget(target, operation, env, status);
    const review = result && "review" in result ? result.review : undefined;

    if (
      operation.kind === "join" &&
      review &&
      operation.preparation &&
      review.archiveSha256 === archiveSha256 &&
      review.reviewDigest !== operation.approval?.reviewDigest
    ) {
      const { approval: _oldApproval, ...record } = operation;
      this.journal.save({ ...record, phase: "reviewing", preparation: { ...operation.preparation, review } });

      return;
    }

    if (result?.phase !== expected || result.archiveSha256 !== archiveSha256 || !result.routes)
      throw new MigrationMessage(
        "The destination has not confirmed activation of this archive. Keep the source stopped and try recovery.",
      );

    if (operation.routes?.fingerprint !== result.routes.fingerprint)
      throw new MigrationMessage(
        "The activated destination reported a different certificate. Check its Network access identity.",
      );
    this.signal.throwIfAborted();

    const worker = await handoffDesktopWorker({
      directory: this.runtime.directory,
      workerGatewayUrl: profile,
      routes: { ...result.routes, addresses: [...result.routes.addresses] },
      signal: this.signal,
      assertStopped: () => this.runtime.assertMigrationServicesStopped(),
    });

    this.journal.save({ ...operation, phase: "switching", routes: result.routes, workerId: worker.workerId });
  }
  private async activateTarget(
    target: Target,
    operation: MigrationJournal,
    env: NodeJS.ProcessEnv,
    status: Awaited<ReturnType<Target["status"]>>,
  ) {
    const { archiveSha256, device, approval } = operation;

    if (!archiveSha256 || !device) throw new Error("Incomplete migration record");

    try {
      if (operation.kind === "move") return await target.activate(archiveSha256, device);

      if (!approval) throw new Error("Missing final join approval");

      if ("review" in status && status.review?.reviewDigest !== approval.reviewDigest) return status;
      const secrets = await this.source.approvedSecrets(env, operation, archiveSha256, approval.approvedSecretIds);
      this.signal.throwIfAborted();

      return await target.join(archiveSha256, device, approval, secrets);
    } catch {
      this.signal.throwIfAborted();

      return target.status();
    }
  }
  recover() {
    return this.run("recover", async () => {
      const operation = this.pending();

      if (!operation) return;

      if (operation.phase === "preparing") await this.trial(operation);

      if (operation.phase === "draining") await this.fence(operation);

      if (operation.phase === "fenced" && (!operation.archiveSha256 || operation.kind === "move")) {
        await this.finalBundle(operation, await this.database(true));
      }

      if (operation.phase === "committed") await this.cutover(operation);

      if (
        operation.phase === "reviewing" ||
        (operation.kind === "join" && operation.phase === "fenced" && operation.archiveSha256)
      )
        await this.recoverReview(operation);
    });
  }
  private async recoverReview(operation: MigrationJournal) {
    const { archiveSha256, device, preparation } = operation;

    if (!archiveSha256 || !device || !preparation?.review) throw new Error("Incomplete join review");
    const remote = await this.target(operation).review(archiveSha256, device);

    if (remote.phase === "applied" && operation.phase === "reviewing") {
      await this.cutover(operation);

      return;
    }

    const review = "review" in remote && remote.review;

    if (!review || review.archiveSha256 !== archiveSha256) throw new Error("Could not confirm the updated join review");
    this.journal.save({ ...operation, preparation: { ...preparation, review } });
  }
  abort() {
    return this.run("abort", async () => {
      const operation = this.pending();

      if (!operation) return;

      if (["committed", "reviewing", "switching"].includes(operation.phase))
        throw new MigrationMessage("The source has been committed. Continue recovery on the destination.");
      const target = await this.target(operation).abort();

      if (target.phase !== "aborted" && target.phase !== "absent")
        throw new MigrationMessage(
          "The destination did not confirm an abort. Keep the source stopped and continue recovery.",
        );
      const fenced = sourceFenced(operation);
      const live = operation.phase === "draining" ? await this.database(false).catch(() => undefined) : undefined;

      if (fenced) {
        if (!live) await this.runtime.stopLocalForMigration();
        await this.source.fence(live ?? (await this.database(true)), operation, "abort");
      }

      await this.source.clear(operation);
      this.journal.clear();
      this.drainingGateway = undefined;

      if (fenced && (!live || !this.runtime.resumeLocalAfterAbortedDrain())) await this.runtime.restore();
    });
  }
  complete(client: DesktopClientCredential) {
    return this.run("complete", async () => {
      const operation = this.pending();

      if (
        operation?.phase !== "switching" ||
        !operation.profile ||
        !operation.routes ||
        !operation.workerId ||
        !operation.device ||
        client.deviceId !== operation.device.id ||
        client.fingerprint !== operation.routes.fingerprint
      )
        throw new Error("The migrated Desktop credential does not match the operation");
      const pinned = routedPinnedTransport(client, client.token);
      await createClient(ui.GatewayService, pinned.transport).getClientCapabilities(
        {},
        { timeoutMs: 5000, signal: this.signal },
      );
      await this.runtime.configure(
        { mode: "remote", gatewayUrl: operation.profile, workerGatewayUrl: operation.profile },
        client,
      );
      await until(
        async () => this.runtime.status.workerId === operation.workerId && this.runtime.status.worker === "online",
        30_000,
        () => !this.signal.aborted,
      ).catch(() => {
        throw new MigrationMessage("The original worker is still reconnecting to the destination. Try recovery again.");
      });
      await this.source.clear(operation);
      this.journal.save({ ...operation, phase: "completed" });
    });
  }
}

function completedTrial(state: Awaited<ReturnType<Target["status"]>>, archiveSha256: string) {
  return (
    ("trial" in state && state.phase === "trialed" && state.trial?.archiveSha256 === archiveSha256) ||
    ("review" in state && state.phase === "reviewed" && state.review?.archiveSha256 === archiveSha256)
  );
}

function checkDestination(directory: string, routes: MigrationJournal["routes"]) {
  const profile = routes && pinnedOrigins(routes.addresses)[0];

  if (!profile)
    throw new MigrationMessage("The server did not advertise a pinned Network access route for this Desktop.");
  const folder = remoteWorkerDirectory(directory, { mode: "remote", gatewayUrl: profile });

  if (["worker.json", "desktop-client.enc", "data"].some((entry) => existsSync(join(folder, entry))))
    throw new MigrationMessage("This target already has a different Remote profile on this computer.");

  return profile;
}
