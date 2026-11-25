import type { MessageInitShape } from "@bufbuild/protobuf";
import type { AgentPreviewEvent, AgentPreviewTargetSchema, AgentPreviewInput } from "@canopy/contracts";
import type { PreviewRuntime } from "./runtime.ts";

export type PreviewUpdate = Partial<Omit<AgentPreviewEvent, "$typeName" | "previewId" | "frameId" | "targets">> & {
  targets?: MessageInitShape<typeof AgentPreviewTargetSchema>[];
};

export interface PreviewBackend {
  start(): Promise<void>;
  input(inputs: readonly AgentPreviewInput[], owner: string): Promise<void>;
  release(owner: string): Promise<void>;
  close(): Promise<void>;
}

export interface PreviewContext {
  readonly runtime: PreviewRuntime;
  readonly signal: AbortSignal;
  emit(update: PreviewUpdate, stillCurrent?: () => boolean): void;
  active(): boolean;
}

export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const LEASE_MS = 15_000;
