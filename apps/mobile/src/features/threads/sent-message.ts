import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { applyThread } from "../../api/thread";

/** Keep the optimistic result only when the watch has not already delivered it. */
export function withSentMessage(snapshot: ui.ThreadSnapshot | undefined, result: ui.SendMessageResponse) {
  let next = snapshot;
  const { turn, steer } = result;

  if (turn && !next?.turns.some((item) => item.id === turn.id))
    next = applyThread(next, create(ui.ThreadUpdateSchema, { change: { case: "turn", value: turn } }));

  if (steer && !next?.steers.some((item) => item.id === steer.id))
    next = applyThread(next, create(ui.ThreadUpdateSchema, { change: { case: "steer", value: steer } }));

  return next;
}
