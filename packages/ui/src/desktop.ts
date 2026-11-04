/** Optional, capability-limited Electron bridge. No filesystem, secrets or generic IPC. */
export type DesktopMode = "local" | "remote";

export type DesktopUpdateChannel = "stable" | "beta" | "nightly";

export type QuitShortcut = "press-twice" | "hold" | "immediately";

export interface QuitGuardState {
  phase: "hint" | "holding" | "cancel";
  shortcut: string;
  durationMs: number;
  message?: string;
}

export interface DesktopWindowState {
  zoomFactor: number;
  fullscreen: boolean;
}

export interface DesktopUpdateStatus {
  version: string;
  buildChannel: DesktopUpdateChannel;
  channel: DesktopUpdateChannel;
  phase: "disabled" | "idle" | "checking" | "downloading" | "downloaded" | "error";
  message: string;
  progress?: number | undefined;
  updateVersion?: string | undefined;
  changingChannel: boolean;
}

export interface DesktopStatus {
  /** Last saved mode selection, without credentials or one-time enrollment fields. */
  configuration?: DesktopSavedConfiguration;
  mode: DesktopMode | null;
  phase: "setup" | "starting" | "running" | "stopping" | "error";
  worker: "offline" | "connecting" | "online";
  clis: { claude: boolean; codex: boolean; grok: boolean };
  error?: string | undefined;
  needsPairing?: boolean | undefined;
  database?:
    | { phase: "downloading" | "verifying" | "installing" | "ready"; message: string; progress?: number }
    | undefined;
  webUrl?: string;
  gatewayUrl?: string;
  workerGatewayUrl?: string;
  allowNetwork: boolean;
  bindHost: string;
}

export type DesktopConfiguration =
  | { mode: "local"; allowNetwork: boolean; bindHost: string }
  | {
      mode: "remote";
      gatewayUrl: string;
      webUrl?: string;
      enrollmentToken?: string;
      gatewayFingerprint?: string;
      pairingInvitation?: string;
      workerGatewayUrl?: string;
    };

export type DesktopSavedConfiguration =
  | Extract<DesktopConfiguration, { mode: "local" }>
  | { mode: "remote"; gatewayUrl: string; workerGatewayUrl?: string };

/** Compare mode fields; a fresh invitation or worker enrollment is always an explicit change. */
export function sameDesktopConfiguration(
  next: DesktopConfiguration,
  saved: DesktopSavedConfiguration | undefined,
): boolean {
  if (!saved || next.mode !== saved.mode) return false;

  if (next.mode === "local") return true;

  if (saved.mode !== "remote") return false;

  if (next.pairingInvitation?.trim() || next.enrollmentToken?.trim() || next.gatewayFingerprint?.trim()) return false;

  try {
    const origins = [
      next.gatewayUrl,
      saved.gatewayUrl,
      next.workerGatewayUrl ?? next.gatewayUrl,
      saved.workerGatewayUrl ?? saved.gatewayUrl,
    ].map((value) => {
      const url = new URL(value);

      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error("Invalid gateway origin");

      return url.origin;
    });

    return origins[0] === origins[1] && origins[2] === origins[3];
  } catch {
    return false;
  }
}

export interface DesktopBridge {
  readonly platform: string;
  windowState(): Promise<DesktopWindowState>;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  status(): Promise<DesktopStatus>;
  /** Only in the bundled setup window. False means the user canceled the restart confirmation. */
  configure(configuration: DesktopConfiguration): Promise<void | boolean>;
  openSettings(): Promise<void>;
  /** Close the mode chooser and focus the existing application without reloading it. */
  closeSettings?(): Promise<void>;
  quitShortcut(): Promise<QuitShortcut>;
  setQuitShortcut(shortcut: QuitShortcut): Promise<QuitShortcut>;
  onQuitShortcut(listener: (shortcut: QuitShortcut) => void): () => void;
  /** Versioned feedback avoids outdated remote overlays saying "again" after the window expires. */
  onQuitGuard(listener: (state: QuitGuardState) => void, overlayVersion?: 1): () => void;
  updates(): Promise<DesktopUpdateStatus>;
  setUpdateChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateStatus>;
  checkForUpdates(): Promise<DesktopUpdateStatus>;
  restartToUpdate(): Promise<void>;
  onUpdates(listener: (status: DesktopUpdateStatus) => void): () => void;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
  onEnrollment(
    listener: (prefill: {
      gatewayUrl: string;
      webUrl: string;
      enrollmentToken: string;
      gatewayFingerprint?: string;
    }) => void,
  ): () => void;
  /** Setup subscribes before asking main to deliver a pending deep link. */
  readyForEnrollment(): Promise<void>;
}

declare global {
  interface Window {
    canopyDesktop?: DesktopBridge;
  }
}
