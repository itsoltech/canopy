import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { HttpError, requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import { workerAction } from "./actions.ts";

/** Metadata only. The wizard owns the plaintext token and discards it on close. */
export class WorkerSetup {
  gatewayUrl = $state("");
  fingerprint = $state("");
  gatewayVersion = $state("");
  channel = $state("nightly");
  enrollments = $state.raw<ui.WorkerEnrollment[]>([]);
  loaded = $state(false);
  error = $state("");
  /** The worker gateway address setting last seen in the stream. */
  #address: string | undefined;
  async reload() {
    try {
      const setup = decode(ui.GetWorkerSetupResponseSchema, await requestJson("GET", "/api/workers/setup"));
      this.gatewayUrl = setup.gatewayUrl;
      this.fingerprint = setup.gatewayFingerprint;
      this.gatewayVersion = setup.gatewayVersion;
      this.channel = setup.channel;
      this.enrollments = setup.enrollments;
      this.loaded = true;
      this.error = "";
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Could not load worker setup";
    }
  }
  apply(update: ui.OverviewUpdate) {
    if (update.change.case === "enrollment") {
      const value = update.change.value;
      this.enrollments = [value, ...this.enrollments.filter((e) => e.id !== value.id)];
    }

    // The gateway address follows its setting and the network routes; other settings change nothing here.
    if (update.change.case === "userSettings") {
      const address = update.change.value.workerGatewayUrl;

      if (address !== this.#address) void this.reload();
      this.#address = address;
    }

    if (update.change.case === "mobileRoutes") void this.reload();
  }
  async saveAddress(address: string) {
    for (let attempt = 0; ; attempt++) {
      const current = decode(ui.GetSettingsResponseSchema, await requestJson("GET", "/api/settings"));

      try {
        await requestJson(
          "PUT",
          "/api/settings/user",
          encode(
            ui.UpdateUserSettingsRequestSchema,
            create(ui.UpdateUserSettingsRequestSchema, {
              expectedVersion: current.user?.version ?? 0n,
              workerGatewayUrl: address.trim(),
            }),
          ),
        );
        await this.reload();

        return;
      } catch (e) {
        if (attempt > 0 || !(e instanceof HttpError) || e.status !== 409) throw e;
      }
    }
  }
  async revoke(id: string) {
    await workerAction("revoke-enrollment", { id });
    await this.reload();
  }
}
