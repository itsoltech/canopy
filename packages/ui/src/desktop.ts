/** Optional, capability-limited Electron bridge. No filesystem, secrets or generic IPC. */
import type { ThemeName } from "./themes.ts";
import type { DesktopHtmlStart, DesktopHtmlCommand, DesktopHtmlEvent } from "./desktop-html.ts";

export type {
  DesktopHtmlTheme,
  DesktopHtmlStart,
  DesktopHtmlModifier,
  DesktopHtmlInput,
  DesktopHtmlHostMessage,
  DesktopHtmlCommand,
  DesktopHtmlEvent,
} from "./desktop-html.ts";

export { isDesktopRoute } from "./desktop-route.ts";

export interface DesktopAppearance {
  scheme: "system" | "light" | "dark";
  light: ThemeName;
  dark: ThemeName;
}

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
  /** Drives the maximize / restore window control on Windows and Linux. */
  maximized?: boolean;
}

/** A window button drawn by the web UI on Windows and Linux (docs/desktop.md). */
export type DesktopWindowControl = "minimize" | "toggle-maximize" | "close";

export const isDesktopWindowControl = (value: string): value is DesktopWindowControl =>
  value === "minimize" || value === "toggle-maximize" || value === "close";

export interface DesktopUpdateStatus {
  checkIntervalMinutes?: number;
  lastCheckedAt?: number;
  nextCheckAt?: number | undefined;
  version: string;
  buildChannel: DesktopUpdateChannel;
  channel: DesktopUpdateChannel;
  phase: "disabled" | "idle" | "checking" | "downloading" | "downloaded" | "error";
  message: string;
  progress?: number | undefined;
  updateVersion?: string | undefined;
  /** Exact cached version available for explicit installation, including during a newer download. */
  stagedVersion?: string | undefined;
  error?: string | undefined;
  /** Release checks pause until the public metadata service's rate limit resets. */
  retryAt?: number | undefined;
  changingChannel: boolean;
  releases?: DesktopReleaseNote[] | undefined;
  publishing?: string | undefined;
}

export interface DesktopReleaseNote {
  version: string;
  markdown: string;
}

export interface DesktopAppHistory {
  version: string;
  from: string;
  updated: boolean;
}

export interface DesktopStatus {
  /** Last saved mode selection, without credentials or one-time enrollment fields. */
  configuration?: DesktopSavedConfiguration;
  mode: DesktopMode | null;
  phase: "setup" | "starting" | "running" | "stopping" | "error";
  worker: "offline" | "connecting" | "online";
  /** Enrolled worker running on this desktop, independent of its connection status. */
  workerId?: string | undefined;
  clis: { claude: boolean; codex: boolean; grok: boolean; agy: boolean };
  error?: string | undefined;
  needsPairing?: boolean | undefined;
  database?:
    | { phase: "downloading" | "verifying" | "installing" | "ready"; message: string; progress?: number }
    | undefined;
  webUrl?: string;
  gatewayUrl?: string | undefined;
  workerGatewayUrl?: string | undefined;
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

export type {
  DesktopMigrationApproval,
  DesktopMigrationBridge,
  DesktopMigrationReview,
  DesktopMigrationStatus,
  DesktopMigrationTarget,
} from "./desktop-migration.ts";

export interface DesktopFileDownload {
  id: string;
  state: "progressing" | "completed" | "cancelled" | "failed";
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
}

export type DesktopNotificationPermissionStatus = "default" | "denied" | "granted";

export interface DesktopNotificationPermission {
  status(): Promise<DesktopNotificationPermissionStatus>;
  request(): Promise<DesktopNotificationPermissionStatus>;
}

export interface DesktopBridge {
  usagePing?: {
    enabled(): Promise<boolean>;
    setEnabled(enabled: boolean): Promise<boolean>;
  };
  gatewayMigration?: import("./desktop-migration.ts").DesktopMigrationBridge;
  /** Opens only the calling thread's automation preview on the current BFF. */
  openPreviewWindow?(path: string): Promise<void>;
  /** Progress from Electron for file links downloaded from this window's BFF. */
  onFileDownload?(listener: (event: DesktopFileDownload) => void): () => void;
  /** Opens untrusted HTML in a separate, network-denied session. Never runs in the app renderer. */
  openAgentHtml?(specJson: string, title: string): Promise<void>;
  /** Inline pixels from the same isolated browser process; replaces any separate viewer. */
  startAgentHtml?(input: DesktopHtmlStart): Promise<void>;
  commandAgentHtml?(id: string, command: DesktopHtmlCommand): Promise<void>;
  stopAgentHtml?(id: string): Promise<void>;
  onAgentHtml?(listener: (event: DesktopHtmlEvent) => void): () => void;
  /** Read-only family enumeration; main validates the application origin and main frame. */
  listFonts?(): Promise<string[]>;
  history?: {
    read(key: string): Promise<{ generation: string; bytes?: Uint8Array }>;
    write(generation: string, key: string, bytes: Uint8Array): Promise<void>;
    remove(key: string): Promise<void>;
    reconcileBots?(generation: string, availableIds: string[]): Promise<void>;
    clear(): Promise<void>;
  };
  /**
   * A native thread or bot alert. Main checks lengths, opens only `/threads/<id>` or `/bots/<id>`
   * and shows each key once across windows (docs/desktop.md).
   */
  showNotification?(notice: {
    key: string;
    title: string;
    body: string;
    path: string;
    sound: boolean;
  }): Promise<boolean>;
  /** Sets the app icon's notification count. Zero clears it. */
  setNotificationBadge?: (count: number) => Promise<void>;
  /** macOS notification authorization for this app bundle. */
  notificationPermission?: DesktopNotificationPermission;
  /** The path of a clicked notification, after main has focused this window. */
  onNotificationClick?(listener: (path: string) => void): () => void;
  /** The native Settings menu also reports whether its keyboard shortcut opened the route. */
  onOpenRoute?(listener: (path: string, keyboard?: boolean) => void): () => void;
  readyForRoutes?(): Promise<void>;
  readonly platform: string;
  /** Bundled icon for the installed desktop channel. */
  readonly startupIcon?: string;
  /** Package version of the running desktop app, including its prerelease suffix. */
  readonly startupVersion?: string;
  /** Local startup palette, also used by the setup page before its first paint. */
  readonly startupAppearance?: {
    scheme: DesktopAppearance["scheme"];
    light: ThemeName;
    dark: ThemeName;
    style: string;
  };
  /** Apply local color preferences to native chrome and remember them for startup. */
  setAppearance?(appearance: DesktopAppearance): Promise<void>;
  windowState(): Promise<DesktopWindowState>;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  /** Minimize, maximize / restore or close the calling window (Windows and Linux draw their own buttons). */
  windowControl?(control: DesktopWindowControl): Promise<void>;
  /** Local drafts fence close/quit before services stop; no file contents cross this bridge. */
  setWorkspaceBlocked?(blocked: boolean): Promise<void>;
  onWorkspaceClose?(listener: (action: "close" | "quit") => void): () => void;
  finishWorkspaceClose?(action: "close" | "quit"): Promise<void>;
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
  /** This app's device-local history, independent of the selected gateway. */
  appUpdateHistory?(): Promise<DesktopAppHistory>;
  /** Validated public Pages notes, read in main without relaxing the renderer's CSP. */
  releaseNotes?(): Promise<string>;
  setUpdateChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateStatus>;
  setUpdateCheckInterval?(minutes: number): Promise<DesktopUpdateStatus>;
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
  /** The sign-in that canopy://oauth/callback returned, once; older desktop builds lack it. */
  takeConnectorOAuth?(): Promise<DesktopConnectorOAuth | undefined>;
}

/** Code and state from canopy://oauth/callback; the gateway checks them like a callback. */
export interface DesktopConnectorOAuth {
  state: string;
  code: string;
  error: string;
  issuer: string;
}

declare global {
  interface Window {
    canopyDesktop?: DesktopBridge;
  }
}
