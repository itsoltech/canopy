import type { ThreadFilesWatch, ThreadFilesUpdate } from "@canopy/contracts";
import { CommandError } from "../runtime/host-types.ts";
import { directoryPath, directoryRefused } from "./thread-directory-path.ts";
import { CheckoutFiles } from "./checkout-files.ts";

export function watchPath(path: string, file = false) {
  if (
    (file && !path) ||
    path.length > 4096 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    path.split("/").some((part) => ["..", ".", ".git"].includes(part))
  )
    throw directoryRefused();
}

interface Subscription {
  request: ThreadFilesWatch;
  checkout?: CheckoutFiles;
}

/** No journal, outbox, disk polling, content or persistent replay. */
export class ThreadFilesWatcher {
  #checkouts = new Map<string, CheckoutFiles>();
  #subscriptions = new Map<string, Subscription>();
  #epoch = 0;

  async watch(request: ThreadFilesWatch, send: (update: ThreadFilesUpdate) => void) {
    const known = this.#subscriptions.get(request.subscriptionId);

    if (request.release) {
      if (
        known &&
        known.request.ownerId === request.ownerId &&
        known.request.threadId === request.threadId &&
        known.request.workspace === request.workspace
      ) {
        known.checkout?.remove(request.subscriptionId);
        this.#subscriptions.delete(request.subscriptionId);
        this.#trim();
      }

      return;
    }

    if (
      known ||
      this.#subscriptions.size >= 32 ||
      request.directories.length + request.files.length > 32 ||
      !request.subscriptionId ||
      request.subscriptionId.length > 64 ||
      request.cursor.length > 128 ||
      request.rootIdentity.length > 64
    )
      throw new CommandError("WATCH_LIMIT", "Close unused Files views, then retry.", false);

    for (const path of request.directories) watchPath(path);

    for (const path of request.files) watchPath(path, true);
    const entry: Subscription = { request };
    this.#subscriptions.set(request.subscriptionId, entry);
    const epoch = this.#epoch;

    try {
      const target = await directoryPath(request.workspace, "");

      if (this.#epoch !== epoch || this.#subscriptions.get(request.subscriptionId) !== entry) return;
      const key = `${request.ownerId}:${target.rootIdentity}`;
      let checkout = this.#checkouts.get(key);

      if (!checkout) {
        this.#trim();

        if (this.#checkouts.size >= 8)
          throw new CommandError("WATCH_LIMIT", "Close unused Files views, then retry.", false);
        checkout = new CheckoutFiles(request.workspace, target.rootIdentity);
        this.#checkouts.set(key, checkout);
      }

      entry.checkout = checkout;
      await checkout.add(request, send);
    } catch (cause) {
      entry.checkout?.remove(request.subscriptionId);
      this.#subscriptions.delete(request.subscriptionId);
      this.#trim();
      throw cause;
    }
  }

  #trim() {
    for (const [key, checkout] of this.#checkouts) if (!checkout.subscribers.size) this.#checkouts.delete(key);
  }

  close() {
    this.#epoch++;

    for (const checkout of this.#checkouts.values()) checkout.close();
    this.#checkouts.clear();
    this.#subscriptions.clear();
  }
}
