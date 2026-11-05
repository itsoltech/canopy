// oxlint-disable-next-line typescript/triple-slash-reference -- Consumers outside gateway need this ambient *.sh declaration; type-importing it turns the wildcard into an ineffective augmentation.
/// <reference path="./worker-installer.d.ts" />
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { Code, ConnectError } from "@connectrpc/connect";
import { Client, type ClientChannel } from "ssh2";
import installer from "../../../../scripts/install-worker.sh" with { type: "text" };
import type { WorkerAdministration } from "./worker-administration.ts";
import { sanitizeSshOutput, type SshTarget } from "./worker-ssh.ts";
import { requireRemoteWorkerAddress, workerSshCommand } from "./worker-ssh-command.ts";
import { workerInstallManifest } from "../updates/install.ts";
import type { GatewayUpdates } from "../updates/runtime.ts";

export interface SshInstallation {
  client: Client;
  events: AsyncChannel<ui.WorkerSshEvent>;
  channel: ClientChannel | undefined;
  fingerprint: string;
  token: string;
  invitationId: string;
  finished: boolean;
  request: ui.WorkerSshRequest;
  signal: AbortSignal;
  target: SshTarget;
  pinned: string | undefined;
  workers: WorkerAdministration;
  updates: GatewayUpdates;
  pin(target: SshTarget, fingerprint?: string): Promise<string | undefined>;
  audit(action: string): Promise<void>;
}

export async function installWorker(session: SshInstallation, fail: (message: string) => void): Promise<void> {
  if (!session.fingerprint || session.fingerprint !== (session.pinned ?? session.request.fingerprint))
    throw new ConnectError("Confirm the SSH host fingerprint before installing", Code.FailedPrecondition);

  if ((await session.pin(session.target, session.fingerprint)) !== session.fingerprint)
    throw new ConnectError("SSH host key changed. Installation blocked.", Code.FailedPrecondition);
  await session.audit("worker.ssh.install.start");
  const setup = await session.workers.setup();
  requireRemoteWorkerAddress(setup.gatewayUrl, session.target.host);
  const manifest = await workerInstallManifest(session.updates);
  session.signal.throwIfAborted();

  const invitation = await session.workers.create(session.request.name, session.request.tags);
  session.token = invitation.token;
  session.invitationId = invitation.enrollment!.id;
  session.signal.throwIfAborted();
  session.events.push(
    create(ui.WorkerSshEventSchema, {
      enrollment: invitation.enrollment,
      fingerprint: session.fingerprint,
      trusted: true,
    }),
  );
  session.client.exec("sh -s", { pty: false }, (error, stream) => {
    if (error) {
      fail("Could not start the fixed installer over SSH");

      return;
    }

    session.channel = stream;
    let output = "";
    let bytes = 0;
    let reused = false;
    let installerError = "";

    const emit = (data: Buffer) => {
      bytes += data.length;

      if (bytes > 128_000) {
        fail("SSH installer output exceeded its limit");

        return;
      }

      output += data.toString("utf8");
      const lines = output.split("\n");
      output = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith("Existing config preserved")) reused = true;

        if (line.startsWith("Canopy: ")) installerError = sanitizeSshOutput(line.slice(8), session.token);
        session.events.push(create(ui.WorkerSshEventSchema, { output: sanitizeSshOutput(line, session.token) + "\n" }));
      }
    };

    stream.on("data", emit);
    stream.stderr.on("data", emit);
    stream.on("close", (code: number | null) => {
      if (output.startsWith("Canopy: ")) installerError = sanitizeSshOutput(output.slice(8), session.token);

      if (output)
        session.events.push(
          create(ui.WorkerSshEventSchema, { output: sanitizeSshOutput(output, session.token) + "\n" }),
        );

      if (code !== 0) {
        fail(installerError || "Worker installation failed. Copy the installation output to check the failed step.");

        return;
      }

      if (reused) {
        fail(
          "This target already has a worker config. Its binary/service were reinstalled without replacing enrollment. Check its existing entry in Settings → Workers.",
        );

        return;
      }

      // A started service is not proof of a connected worker. Keep the RPC alive until Hello.
      void (async () => {
        session.events.push(
          create(ui.WorkerSshEventSchema, { output: "Waiting for the worker to connect to Canopy…\n" }),
        );
        const deadline = Date.now() + 60_000;

        while (!session.events.closed) {
          session.signal.throwIfAborted();
          const current = (await session.workers.setup()).enrollments.find((e) => e.id === session.invitationId);

          if (current?.workerId && session.workers.options.link.connections.has(current.workerId)) {
            await session.audit("worker.ssh.install.finish");
            session.finished = true;
            session.events.push(
              create(ui.WorkerSshEventSchema, { enrollment: current, output: "Worker connected to Canopy.\n" }),
            );
            session.events.close();

            return;
          }

          if (Date.now() >= deadline) {
            fail(
              "Service started, but the worker did not connect within 60 seconds. Check the target's access to the worker gateway address.",
            );

            return;
          }

          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
      })().catch(() => fail("Could not confirm the worker connection"));
    });
    // Secrets travel through encrypted stdin, never the SSH command, logs or browser.
    stream.end(
      `${workerSshCommand(setup, manifest, session.updates.version, session.token, session.request.name)}${installer}\n`,
    );
  });
}
