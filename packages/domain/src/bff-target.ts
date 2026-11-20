/**
 * Where a web BFF hosted inside another process sends its gateway calls. The desktop controller runs the bundled
 * web in its own process and changes the target when the user switches between local and remote mode or pairs
 * another computer; a server BFF has no target and reads GATEWAY_URL / GATEWAY_SERVICE_TOKEN from its environment.
 * Process-wide: one BFF per process.
 */
export interface LocalBffTarget {
  mode: "local";
  gatewayUrl: string;
  certificate: string;
  fingerprint: string;
  serviceToken: string;
}

export type BffTarget =
  | { mode: "offline" }
  | LocalBffTarget
  | { mode: "remote"; gatewayUrl: string; desktopClient: { token: string; routes: string } };

export interface BffTargetState {
  target: BffTarget;
  /** Changes with every new target, so the BFF rebuilds its gateway client. */
  generation: number;
}

declare global {
  var canopyBffTarget: BffTargetState | undefined;
  var canopyBffTargetListeners: Set<() => void> | undefined;
}

export function setBffTarget(target: BffTarget): void {
  for (const listener of globalThis.canopyBffTargetListeners ?? []) listener();
  globalThis.canopyBffTarget = { target, generation: (globalThis.canopyBffTarget?.generation ?? 0) + 1 };
}

/** Also crosses the controller/bundled BFF boundary: private read models close before a target switch. */
export function onBffTargetChange(listener: () => void): () => void {
  const listeners = (globalThis.canopyBffTargetListeners ??= new Set());
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function bffTarget(): BffTargetState | undefined {
  return globalThis.canopyBffTarget;
}
