import { clone, create, equals, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

export const composerTargetKey = (target: ui.ComposerDraftTarget) =>
  JSON.stringify([target.threadId, target.projectId, target.workspaceId, target.parentThreadId]);

export const hasComposerContent = (content: ui.ComposerDraftContent | undefined, files = 0) =>
  Boolean(
    content?.text.length || content?.mentions.length || content?.quotes.length || content?.attachments.length || files,
  );

/** Append without losing mention/citation offsets or file identities. Repeated claims are handled by the caller. */
export function mergeComposerContent(local: ui.ComposerDraftContent, incoming: ui.ComposerDraftContent) {
  const separator = local.text && incoming.text ? "\n\n" : "";
  const offset = local.text.length + separator.length;
  const ids = new Set(local.attachments.map((a) => a.id));

  return create(ui.ComposerDraftContentSchema, {
    ...incoming,
    ...local,
    model: local.model ?? incoming.model,
    effort: local.effort ?? incoming.effort,
    permissionMode: local.permissionMode ?? incoming.permissionMode,
    provider: local.provider || incoming.provider,
    providerProfileId: local.providerProfileId || incoming.providerProfileId,
    clientRequestId: incoming.clientRequestId,
    text: local.text + separator + incoming.text,
    mentions: [
      ...local.mentions,
      ...incoming.mentions.map((m) => ({ ...m, start: m.start + offset, end: m.end + offset })),
    ],
    quotes: [
      ...local.quotes,
      ...incoming.quotes.map((q) => ({
        ...q,
        start: q.start === undefined ? undefined : q.start + offset,
        end: q.end === undefined ? undefined : q.end + offset,
      })),
    ],
    attachments: [...local.attachments, ...incoming.attachments.filter((a) => !ids.has(a.id))],
  });
}

const maxAge = 30 * 86400_000;
const maxBytes = 4 * 1024 * 1024;
const maxEntries = 100;

/** The app provides a scoped atomic storage adapter. No transcript, worker or diagnostic cache sees drafts. */
export class ComposerLocalStore {
  #entries = new Map<string, ui.LocalComposerDraft>();
  #listeners = new Set<() => void>();
  #keys = new Map<string, Set<() => void>>();
  #serialized = new Map<string, string>();
  #dirty = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  error = "";
  closed = false;
  version = 0;
  snapshot = () => this.version;

  constructor(
    readonly persist: (key: string, raw: string | null) => void,
    readonly newId: () => string,
    readonly settled?: () => Promise<void>,
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
  subscribeKey(target: ui.ComposerDraftTarget, listener: () => void) {
    const key = composerTargetKey(target);
    const listeners = this.#keys.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.#keys.set(key, listeners);

    return () => {
      listeners.delete(listener);

      if (!listeners.size) this.#keys.delete(key);
    };
  }
  /** Cross-tab changes affect only their target and never rewrite another tab's data. */
  receive(key: string, raw: string | null) {
    if (this.#dirty.has(key)) return false;
    const had = this.#entries.has(key);

    try {
      if (raw) {
        const entry = fromJsonString(ui.LocalComposerDraftSchema, raw);

        if (!entry.draft?.target || composerTargetKey(entry.draft.target) !== key) return false;

        if (Date.now() - Number(entry.touchedAtMs) >= maxAge) return false;
        this.#entries.set(key, entry);
        this.#serialized.set(key, raw);
      } else {
        this.#entries.delete(key);
        this.#serialized.delete(key);
      }

      this.#emitKey(key, had !== this.#entries.has(key));

      return true;
    } catch {
      this.error = "Could not restore drafts. Start a new draft.";

      return false;
    }
  }
  load(raw: string | null) {
    this.#entries.clear();
    this.#serialized.clear();

    if (!raw) {
      this.#emit();

      return;
    }

    try {
      const loaded = fromJsonString(ui.LocalComposerDraftsSchema, raw);
      this.#entries.clear();

      for (const entry of loaded.entries.slice(0, maxEntries)) {
        if (entry.draft?.target && Date.now() - Number(entry.touchedAtMs) < maxAge) {
          this.#entries.set(composerTargetKey(entry.draft.target), entry);
          this.#serialized.set(composerTargetKey(entry.draft.target), toJsonString(ui.LocalComposerDraftSchema, entry));
        }
      }

      this.#emit();
    } catch {
      this.error = "Could not restore drafts. Start a new draft.";
    }
  }
  list() {
    return [...this.#entries.values()];
  }
  get(target: ui.ComposerDraftTarget) {
    return this.#entries.get(composerTargetKey(target));
  }
  make(target: ui.ComposerDraftTarget, deviceId: string, deviceName: string) {
    return (
      this.get(target) ??
      create(ui.LocalComposerDraftSchema, {
        draft: {
          id: this.newId(),
          target,
          deviceId,
          deviceName,
          content: { clientRequestId: this.newId() },
        },
        touchedAtMs: BigInt(Date.now()),
      })
    );
  }
  put(entry: ui.LocalComposerDraft) {
    if (this.closed) return;
    const target = entry.draft?.target;

    if (!target) return;
    const key = composerTargetKey(target);
    const previous = this.#entries.get(key);

    const next = clone(ui.LocalComposerDraftSchema, entry);
    next.touchedAtMs = previous?.touchedAtMs ?? next.touchedAtMs;

    if (previous && equals(ui.LocalComposerDraftSchema, previous, next)) return;

    if (
      !hasComposerContent(entry.draft?.content, entry.files.length) &&
      !entry.pendingSend.length &&
      !entry.pendingCreate.length &&
      !entry.pendingForm
    ) {
      this.remove(target);

      return;
    }

    next.touchedAtMs = BigInt(Date.now());
    this.#entries.set(key, next);
    this.#serialized.set(key, toJsonString(ui.LocalComposerDraftSchema, next));
    this.#dirty.add(key);
    this.#save();
    this.#emitKey(key, !previous);
  }
  remove(target: ui.ComposerDraftTarget) {
    const key = composerTargetKey(target);

    if (!this.#entries.delete(key)) return;
    this.#serialized.delete(key);
    this.#dirty.add(key);
    this.#save();
    this.#emitKey(key, true);
  }
  #save() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this.#timer);

    if (this.closed) return;

    const sorted = this.list()
      .filter((e) => Date.now() - Number(e.touchedAtMs) < maxAge)
      .sort((a, b) => Number(b.touchedAtMs - a.touchedAtMs));

    let bytes = 0;
    const kept = new Set<string>();

    for (const entry of sorted) {
      if (!entry.draft?.target) continue;
      const key = composerTargetKey(entry.draft.target);
      const size = (this.#serialized.get(key)?.length ?? 0) * 2;

      if (bytes + size > maxBytes || kept.size >= maxEntries) continue;
      bytes += size;
      kept.add(key);
    }

    for (const [key, entry] of this.#entries)
      if (!kept.has(key) && entry.draft?.target) this.remove(entry.draft.target);

    try {
      for (const key of this.#dirty) this.persist(key, this.#serialized.get(key) ?? null);
      this.#dirty.clear();
      this.error = "";
    } catch {
      this.error = "Could not keep this draft after closing the app. Free some storage, then retry.";
    }
  }
  async checkpoint() {
    this.flush();
    await this.settled?.();
  }
  dispose() {
    this.flush();
    this.closed = true;
    clearTimeout(this.#timer);
    this.#listeners.clear();
    this.#keys.clear();
  }
  #emitKey(key: string, membership: boolean) {
    for (const listener of this.#keys.get(key) ?? []) listener();

    if (membership) this.#emit();
  }
  #emit() {
    this.version++;

    for (const listener of this.#listeners) listener();
  }
}
