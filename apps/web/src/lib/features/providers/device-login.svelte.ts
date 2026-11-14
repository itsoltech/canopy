import { Provider, ProviderProfileKind } from "@canopy/contracts";
import { providerCall } from "./instances.ts";

/** Codex instances on a device login or their own login sign in from the app; proxies and other harnesses do not. */
export const signsInFromApp = (harness: Provider, kind: ProviderProfileKind | undefined): boolean =>
  harness === Provider.CODEX && kind === ProviderProfileKind.NATIVE;

/**
 * A ChatGPT device-code sign-in the worker runs (Settings and a failed turn share it). The code shows until the worker
 * reports the account again (`report` changes: the sign-in finished or failed) or the user starts over.
 */
export class DeviceLogin {
  code = $state<{ url: string; userCode: string }>();
  busy = $state(false);
  failure = $state<string>();
  #report = "";

  constructor(readonly target: () => { harness: Provider; id: string; workerId: string; report: string }) {}

  /** Call from an effect: a new account report ends the wait for the code. */
  settle(): void {
    if (this.code && this.target().report !== this.#report) this.code = undefined;
  }

  async start(): Promise<void> {
    const { harness, id, workerId, report } = this.target();
    this.busy = true;
    this.failure = undefined;

    try {
      const started = await providerCall("login", { harness, id, workerId }, 70_000);
      this.#report = report;
      this.code = { url: started.verificationUrl, userCode: started.userCode };
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
}
