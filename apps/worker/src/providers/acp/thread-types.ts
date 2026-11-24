import type {
  AcpClient,
  AcpOptions,
  InitializeResult,
  SessionResult,
  PermissionRequest,
  PermissionResult,
  ToolCall,
} from "@canopy/acp";
import type {
  InteractionRequest,
  InteractionResponse,
  PermissionMode,
  ThreadEvent,
  ThreadSpec,
} from "@canopy/contracts";
import type { JsonValue } from "@canopy/domain";
import type { HarnessKind } from "@canopy/domain/diagnostics";
import type { ViewImageResult } from "../../images/index.ts";
import type { ThreadEventInit } from "../../journal/index.ts";
import type { ResolvedProfile } from "../profiles.ts";
import type { AutomationMcpOptions } from "../local-automation.ts";
import type { AcpEventMapper } from "./mapping.ts";
import type { AcpPermissionEntry } from "./permissions.ts";

export interface AcpThreadOptions extends AutomationMcpOptions {
  dataDir: string;
  executable: string;
  linkDeviceLogin: boolean;
  idleUnloadMs?: number;
  profile(id: string): ResolvedProfile | undefined;
  record(threadId: string, init: ThreadEventInit): Promise<ThreadEvent>;
  interact(request: InteractionRequest, signal?: AbortSignal): Promise<InteractionResponse>;
  viewImage?(threadId: string, cwd: string, path: string): Promise<ViewImageResult>;
}

export interface AcpSettings {
  model: string;
  effort: string;
  permissionMode: PermissionMode;
}

export interface AcpThreadLaunch {
  options: AcpOptions;
  validate?(info: InitializeResult): void;
  cleanup(): void | Promise<void>;
  configure(client: AcpClient, session: SessionResult): Promise<void>;
  mapper(turnId: string): AcpEventMapper;
  permission(entry: AcpPermissionEntry, request: PermissionRequest, signal: AbortSignal): Promise<PermissionResult>;
}

export interface AcpProvider {
  kind: HarnessKind;
  name: string;
  launch(spec: ThreadSpec, profile: ResolvedProfile, settings: AcpSettings, resuming: boolean): AcpThreadLaunch;
  platformUse?(tool: ToolCall): { name: string; args: JsonValue } | undefined;
}

export interface AcpThreadSession extends AcpPermissionEntry {
  client: AcpClient;
  session: SessionResult;
  mapper(turnId: string): AcpEventMapper;
  dispose(): Promise<void>;
  turn: AbortController | undefined;
  settings: string;
  toolUses: Map<string, { name: string; args: JsonValue }>;
  idleTimer?: ReturnType<typeof setTimeout>;
}
