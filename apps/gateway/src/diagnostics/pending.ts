import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { EncodedMinute } from "./store.ts";
import { decodeRollup } from "./rollup.ts";

export const PENDING_BYTES = 4 * 1024 * 1024;
export const PENDING_ENTRY_BYTES = 4096;

/** Called under the home lock: a failed lock attempt never expands pending payloads. */
export function pendingState(minutes: EncodedMinute[], state: ui.DiagnosticsState) {
  if (!minutes.length) return state;

  const watermarks = new Map<string, ui.DiagnosticsProcess>();

  for (const minute of minutes)
    for (const process of decodeRollup(minute.payload).processes) {
      for (const checkpoint of process.checkpoints) {
        const key = `${process.processId}:${checkpoint.session}`;

        if (!watermarks.has(key) && watermarks.size >= 126) throw new Error("Diagnostics watermark budget exceeded");
        watermarks.set(
          key,
          create(ui.DiagnosticsProcessSchema, {
            processId: process.processId,
            session: checkpoint.session,
            sequence: checkpoint.sequence,
          }),
        );
      }

      for (const range of process.coverage)
        if (range.endMs > state.persistedThroughMs) state.persistedThroughMs = range.endMs;
    }

  state.watermarks = [...watermarks.values()];

  return state;
}
