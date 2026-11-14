import { Provider, ProviderProfileKind, type ProviderAccountStatus } from "@canopy/contracts";
import { providerCall } from "./instances.ts";

/** Native instances sign in through the official CLI on their worker. */
export const signsInFromApp = (harness: Provider, kind: ProviderProfileKind | undefined): boolean =>
  [Provider.CODEX, Provider.CLAUDE, Provider.GROK].includes(harness) && kind === ProviderProfileKind.NATIVE;

/** What a sign-in on the device login changes, said the same in Settings and under a failed turn. */
export const deviceLoginNote = (workerName: string, harness = Provider.CODEX): string => {
  const cli =
    harness === Provider.CLAUDE ? "claude auth login" : harness === Provider.GROK ? "grok login" : "codex login";

  return `This changes the CLI account on ${workerName}, as ${cli} does.`;
};

/**
 * A CLI sign-in the worker runs (Settings and a failed turn share it). The code shows until the
 * worker reports this sign-in's outcome (ProviderAccountStatus.login_id and login_outcome), not just any new report.
 */
export class DeviceLogin {
  code = $state<{ url: string; userCode: string; requiresCode: boolean }>();
  busy = $state(false);
  failure = $state<string>();
  #loginId = "";
  #target = "";

  #key(): string {
    const { harness, id, workerId } = this.target();

    return `${workerId}/${harness}/${id}`;
  }

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
    const key = this.#key();

    if (this.#target !== key) {
      this.#target = key;
      this.#loginId = "";
      this.code = undefined;
      this.failure = undefined;
      this.busy = false;
    }

    const account = this.target().account;

    if (!this.code || !this.#loginId || account?.loginId !== this.#loginId) return;

    if (account.loginOutcome !== "signed_in" && account.loginOutcome !== "failed") return;

    if (account.loginOutcome === "failed") this.failure = "The sign-in did not finish. Start it again.";
    this.code = undefined;
    this.#loginId = "";
  }

  async start(): Promise<void> {
    const { harness, id, workerId } = this.target();
    const key = this.#key();
    this.#target = key;
    this.busy = true;
    this.failure = undefined;

    try {
      const started = await providerCall("login", { harness, id, workerId }, 70_000);

      if (this.#key() !== key) return;
      this.#loginId = started.loginId;
      this.code = { url: started.verificationUrl, userCode: started.userCode, requiresCode: started.requiresCode };
    } catch (error) {
      if (this.#key() !== key) return;
      this.failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.#key() === key) this.busy = false;
    }
  }

  async submit(code: string): Promise<void> {
    const { harness, id, workerId } = this.target();
    const key = this.#key();
    this.busy = true;
    this.failure = undefined;

    try {
      await providerCall("complete", { harness, id, workerId, loginId: this.#loginId, code: code.trim() });

      if (this.#key() !== key) return;

      if (this.code) this.code = { ...this.code, requiresCode: false };
    } catch (error) {
      if (this.#key() !== key) return;
      this.failure = error instanceof Error ? error.message : "Could not submit the code. Start sign-in again.";
    } finally {
      if (this.#key() === key) this.busy = false;
    }
  }
}
