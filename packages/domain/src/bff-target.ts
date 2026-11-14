/**
 * Where a web BFF hosted inside another process sends its gateway calls. The desktop controller runs the bundled
 * web in its own process and changes the target when the user switches between local and remote mode or pairs
 * another computer; a server BFF has no target and reads GATEWAY_URL / GATEWAY_SERVICE_TOKEN from its environment.
 * Process-wide: one BFF per process.
 */
export interface BffTarget {
  gatewayUrl: string;
  serviceToken: string;
  /** Remote mode: this desktop's client credential and the paired gateway's routes (ui.MobileRoutes JSON). */
  desktopClient?: { token: string; routes: string };
}

export interface BffTargetState {
  target: BffTarget;
  /** Changes with every new target, so the BFF rebuilds its gateway client. */
  generation: number;
}

declare global {
  var canopyBffTarget: BffTargetState | undefined;
}

export function setBffTarget(target: BffTarget): void {
  globalThis.canopyBffTarget = { target, generation: (globalThis.canopyBffTarget?.generation ?? 0) + 1 };
}

export function bffTarget(): BffTargetState | undefined {
  return globalThis.canopyBffTarget;
}
