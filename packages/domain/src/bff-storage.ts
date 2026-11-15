import type { ui } from "@canopy/contracts";

declare global {
  var canopyBffStorage: (() => ui.DiagnosticsStorage) | undefined;
  var canopyBffStorageWorker: (() => string | undefined) | undefined;
}

/** Private controller → bundled BFF hook. The renderer never chooses filesystem roots. */
export function setBffStorage(read: () => ui.DiagnosticsStorage, worker?: () => string | undefined): void {
  globalThis.canopyBffStorage = read;
  globalThis.canopyBffStorageWorker = worker;
}

export function bffStorage(): ui.DiagnosticsStorage | undefined {
  return globalThis.canopyBffStorage?.();
}

export function bffStorageWorker(): string | undefined {
  return globalThis.canopyBffStorageWorker?.();
}
