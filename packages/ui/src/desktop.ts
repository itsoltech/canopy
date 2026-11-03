/** Optional, capability-limited Electron bridge. No filesystem, secrets or generic IPC. */
export type DesktopMode = "local" | "remote";
export type DesktopUpdateChannel = "stable" | "beta" | "nightly";
export type QuitShortcut = "press-twice" | "hold" | "immediately";
export interface QuitGuardState {
  phase: "hint" | "holding" | "cancel";
  shortcut: string;
  durationMs: number;
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
  mode: DesktopMode | null;
  phase: "setup" | "starting" | "running" | "stopping" | "error";
  worker: "offline" | "connecting" | "online";
  clis: { claude: boolean; codex: boolean; grok: boolean };
  error?: string | undefined;
  database?: { phase: "downloading" | "verifying" | "installing" | "ready"; message: string; progress?: number } | undefined;
  webUrl?: string;
  gatewayUrl?: string;
  allowNetwork: boolean;
  bindHost: string;
}
export type DesktopConfiguration =
  | { mode: "local"; allowNetwork: boolean; bindHost: string }
  | { mode: "remote"; gatewayUrl: string; webUrl: string; enrollmentToken?: string };
export interface DesktopBridge {
  readonly platform: string;
  windowState(): Promise<DesktopWindowState>;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  status(): Promise<DesktopStatus>;
  /** Only available in the bundled setup window, never in remote web content. */
  configure(configuration: DesktopConfiguration): Promise<void>;
  openSettings(): Promise<void>;
  quitShortcut(): Promise<QuitShortcut>;
  setQuitShortcut(shortcut: QuitShortcut): Promise<QuitShortcut>;
  onQuitShortcut(listener: (shortcut: QuitShortcut) => void): () => void;
  onQuitGuard(listener: (state: QuitGuardState) => void): () => void;
  updates(): Promise<DesktopUpdateStatus>;
  setUpdateChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateStatus>;
  checkForUpdates(): Promise<DesktopUpdateStatus>;
  restartToUpdate(): Promise<void>;
  onUpdates(listener: (status: DesktopUpdateStatus) => void): () => void;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
  onEnrollment(listener: (prefill: { gatewayUrl: string; webUrl: string; enrollmentToken: string }) => void): () => void;
  /** Setup subscribes before asking main to deliver a pending deep link. */
  readyForEnrollment(): Promise<void>;
}
declare global {
  interface Window { canopyDesktop?: DesktopBridge }
}
