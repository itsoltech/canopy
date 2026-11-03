import type { ItemStatus, ToolCall } from "@canopy/contracts";

/** What every tool body gets: the call, its parsed input, its item status and whether output still streams. */
export interface ToolBodyProps {
  readonly call: ToolCall;
  readonly input: Record<string, unknown>;
  readonly status: ItemStatus;
  readonly streaming: boolean;
}
