import type { InstallKind, ReleaseSourceOptions } from "@canopy/updater";
import type { UpdatePersistence } from "./persistence.ts";

export interface GatewayUpdatesOptions {
  persistence: Pick<
    UpdatePersistence,
    "admin" | "channel" | "setChannel" | "workers" | "hello" | "saveCommand" | "report"
  >;
  authenticate(credential: string): Promise<string | undefined>;
  cacheDir?: string;
  source?: ReleaseSourceOptions;
  channel?: string;
  version?: string;
  kind?: InstallKind;
  /** The desktop app's bundled gateway (desktop role): it and its own worker update with the app. */
  bundled?: boolean;
  binaryPath?: string;
  restart?(exitCode?: number): Promise<void>;
  departure?(state: "updating" | "restarting", target?: string): Promise<void>;
  recovered?(state: string, reason: string, target?: string): Promise<void>;
  idle?(): Promise<boolean>;
  relocating?(): boolean;
  drain?(value: boolean): void;
  log?(message: string): void;
  pollMs?: number;
  /** The update center changed: state, a check, or a worker's update report. Clients read it again. */
  changed?(): void;
  /** This gateway found a newer release on its channel: other computers on it can check their own feeds. */
  found?(release: { channel: string; version: string }): void;
  /** A current problem of this gateway's installation shown next to its update state (the embedded web). */
  notice?(): string;
}
