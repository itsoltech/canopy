import type { ui } from "@canopy/contracts";
import { ComposerLocalStore, composerTargetKey } from "@canopy/domain/composer-drafts";
import { Code, ConnectError, type Client } from "@connectrpc/connect";
import { MobileRemoteDrafts } from "./remote";
import { MobileComposerState } from "./store";

export class MobileDrafts {
  readonly remote = new MobileRemoteDrafts();
  #revision = 0n;
  #live = new Map<string, MobileComposerState>();
  #remote = new Set<() => void>();
  subscribeRemote = (listener: () => void) => {
    this.#remote.add(listener);

    return () => {
      this.#remote.delete(listener);
    };
  };
  async watch(api: Client<typeof ui.GatewayService>, signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        for await (const change of api.watchComposerDrafts(
          { afterRevision: this.#revision },
          { signal, timeoutMs: 0 },
        )) {
          this.#revision = change.revision;
          this.remote.invalidate();

          const page = await this.remote.load(
            api,
            this.deviceId,
            false,
            this.local.list().flatMap((entry) => entry.draft?.id ?? []),
          );

          for (const move of page.moves) {
            for (const entry of this.local.list())
              if (entry.draft?.id === move.id && entry.draft.target) this.get(entry.draft.target).acceptMove(move);
          }

          for (const listener of this.#remote) listener();
        }
      } catch (cause) {
        if (ConnectError.from(cause).code === Code.Unimplemented) return;
      }

      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };

        const timer = setTimeout(done, 2000);
        signal.addEventListener("abort", done, { once: true });

        if (signal.aborted) done();
      });
    }
  }
  async close() {
    this.local.dispose();
    await this.flush();
    this.#live.clear();
  }
  removeThread(threadId: string) {
    for (const entry of this.local.list()) {
      const target = entry.draft?.target;

      if (!target || (target.threadId !== threadId && target.parentThreadId !== threadId)) continue;
      const key = composerTargetKey(target);
      this.#live.get(key)?.clear();
      this.#live.delete(key);
      this.local.remove(target);
    }

    void this.flush();
  }
  constructor(
    readonly local: ComposerLocalStore,
    readonly deviceId: string,
    readonly deviceName: string,
    readonly flush: () => Promise<void>,
  ) {}
  get(target: ui.ComposerDraftTarget) {
    const key = composerTargetKey(target);
    let current = this.#live.get(key);

    if (!current) {
      if (this.#live.size >= 100) {
        const idle = [...this.#live].find(
          ([, value]) =>
            !value.pendingSend && !value.pendingCreate && !value.files.current.some((f) => !f.attachment && !f.error),
        );

        if (idle) this.#live.delete(idle[0]);
      }

      current = new MobileComposerState(this.local.make(target, this.deviceId, this.deviceName), this.local);
      this.#live.set(key, current);
    }

    return current;
  }
}
