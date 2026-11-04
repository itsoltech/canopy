import type { ItemStatus, ToolCall } from "@canopy/contracts";
import type { JsonObject } from "#lib/shared/json.ts";

/** What every tool body gets: the call, its parsed input, its item status and whether output still streams. */
export interface ToolBodyProps {
  readonly call: ToolCall;
  readonly input: JsonObject;
  readonly status: ItemStatus;
  readonly streaming: boolean;
}
