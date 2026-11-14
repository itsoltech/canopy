import { Provider, ProviderProfileKind, type ProviderAccountStatus } from "@canopy/contracts";
import { providerCall } from "./instances.ts";

/** Codex instances on a device login or their own login sign in from the app; proxies and other harnesses do not. */
export const signsInFromApp = (harness: Provider, kind: ProviderProfileKind | undefined): boolean =>
  harness === Provider.CODEX && kind === ProviderProfileKind.NATIVE;

/** What a sign-in on the device login changes, said the same in Settings and under a failed turn. */
export const deviceLoginNote = (workerName: string): string =>
  `This also changes the Codex CLI account on ${workerName}, as codex login does.`;

/**
 * A ChatGPT device-code sign-in the worker runs (Settings and a failed turn share it). The code shows until the
 * worker reports this sign-in's outcome (ProviderAccountStatus.login_id and login_outcome), not just any new report.
 */
export class DeviceLogin {
  code = $state<{ url: string; userCode: string }>();
  busy = $state(false);
  failure = $state<string>();
  #loginId = "";

  constructor(
    readonly target: () => {
      harness: Provider;
      id: string;
      workerId: string;
      account: ProviderAccountStatus | undefined;
    },
  ) {}

  /** Call from an effect: the code goes when the worker reports that this sign-in finished or failed. */
  settle(): void {
    const account = this.target().account;

    if (!this.code || !this.#loginId || account?.loginId !== this.#loginId) return;

    if (account.loginOutcome !== "signed_in" && account.loginOutcome !== "failed") return;

    if (account.loginOutcome === "failed") this.failure = "The sign-in did not finish. Start it again.";
    this.code = undefined;
    this.#loginId = "";
  }

  async start(): Promise<void> {
    const { harness, id, workerId } = this.target();
    this.busy = true;
    this.failure = undefined;

    try {
      const started = await providerCall("login", { harness, id, workerId }, 70_000);
      this.#loginId = started.loginId;
      this.code = { url: started.verificationUrl, userCode: started.userCode };
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
}
