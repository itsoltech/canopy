/** Optional, capability-limited Electron bridge. No filesystem, secrets or generic IPC. */
export type DesktopMode = "local" | "remote";
export interface DesktopStatus {
  mode: DesktopMode | null;
  phase: "setup" | "starting" | "running" | "stopping" | "error";
  worker: "offline" | "connecting" | "online";
  clis: { claude: boolean; codex: boolean; grok: boolean };
  error?: string | undefined;
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
  status(): Promise<DesktopStatus>;
  /** Only available in the bundled setup window, never in remote web content. */
  configure(configuration: DesktopConfiguration): Promise<void>;
  openSettings(): Promise<void>;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
  onEnrollment(listener: (prefill: { gatewayUrl: string; webUrl: string; enrollmentToken: string }) => void): () => void;
  /** Setup subscribes before asking main to deliver a pending deep link. */
  readyForEnrollment(): Promise<void>;
}
declare global {
  interface Window { canopyDesktop?: DesktopBridge }
}
