import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { ComposerLocalStore, composerTargetKey } from "@canopy/domain/composer-drafts";
import { WebComposerDraft } from "./state.svelte.ts";
import type { AttachmentLimits } from "@canopy/domain";
import { untrack } from "svelte";

class WebDrafts {
  version = $state(0);
  ready = $state(false);
  generation = $state(0);
  deviceId = "";
  deviceName = "";
  scope = "";
  #live = new Map<string, WebComposerDraft>();
  #stopStorage: (() => void) | undefined;
  local = new ComposerLocalStore(
    () => {},
    () => crypto.randomUUID(),
  );
  constructor() {
    this.local.subscribe(() => {
      untrack(() => this.version++);
    });
  }
  connect(scope: string) {
    if (this.scope === scope) return;
    this.local.dispose();
    this.#stopStorage?.();
    this.scope = scope;
    const key = `canopy:composer-drafts:v1:${scope}`;
    this.local = new ComposerLocalStore(
      (target, raw) => {
        if (raw) localStorage.setItem(`${key}:${target}`, raw);
        else localStorage.removeItem(`${key}:${target}`);
      },
      () => crypto.randomUUID(),
    );
    this.local.subscribe(() => {
      untrack(() => this.version++);
    });
    this.#live.clear();
    const identityKey = `canopy:composer-device:${scope}`;

    try {
      this.deviceId = localStorage.getItem(identityKey) || crypto.randomUUID();
      localStorage.setItem(identityKey, this.deviceId);
      // Migrate the former snapshot once, then persist only changed targets.
      const legacy = localStorage.getItem(key);

      if (legacy) {
        this.local.load(legacy);

        for (const entry of this.local.list()) {
          const target = entry.draft?.target;

          if (target) {
            this.local.remove(target);
            this.local.put(entry);
          }
        }

        this.local.flush();
        localStorage.removeItem(key);
      }

      for (let index = 0; index < localStorage.length; index++) {
        const stored = localStorage.key(index);

        if (stored?.startsWith(`${key}:`))
          this.local.receive(stored.slice(key.length + 1), localStorage.getItem(stored));
      }

      const receive = (event: StorageEvent) => {
        if (event.storageArea !== localStorage || !event.key?.startsWith(`${key}:`)) return;
        const targetKey = event.key.slice(key.length + 1);
        this.local.receive(targetKey, event.newValue);
        this.#live.delete(targetKey);
        this.generation++;
      };

      window.addEventListener("storage", receive);
      this.#stopStorage = () => window.removeEventListener("storage", receive);
    } catch {
      this.deviceId = crypto.randomUUID();
    }

    this.deviceName = navigator.userAgent.includes("iPhone")
      ? "iPhone"
      : navigator.userAgent.includes("Mac")
        ? "Mac"
        : navigator.userAgent.includes("Windows")
          ? "Windows computer"
          : "Computer";
    this.ready = true;
    this.generation++;
    this.version++;
  }
  get(target: ui.ComposerDraftTarget, limits: () => AttachmentLimits) {
    void this.ready;
    void this.generation;
    const key = composerTargetKey(target);
    let live = this.#live.get(key);

    if (!live) {
      if (this.#live.size >= 100) {
        const idle = [...this.#live].find(
          ([, value]) =>
            !value.pendingSend && !value.pendingForm && !value.files.files.some((f) => f.status === "uploading"),
        );

        if (idle) this.#live.delete(idle[0]);
      }

      live = new WebComposerDraft(this.local.make(target, this.deviceId, this.deviceName), limits, this.local);
      this.#live.set(key, live);
    }

    return live;
  }
  has(threadId: string) {
    void this.version;

    return Boolean(this.local.get(create(ui.ComposerDraftTargetSchema, { threadId })));
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

    this.local.flush();
  }
}

export const webDrafts = new WebDrafts();
