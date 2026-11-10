import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { LinkedComputers } from "../computers/runtime.ts";
import { LINKED_FEEDS } from "../core/owner-feeds.ts";

/** Announces complete push coverage; a reachable home without a feed keeps clients polling it. */
export function linkedFeeds(computers: LinkedComputers, push: (update: ui.OverviewUpdate) => void) {
  let own: readonly string[] | undefined;
  const peers = new Map<string, readonly string[]>();
  let sent = "";

  const update = () => {
    if (!own) return;
    const reachable = computers.reachable();

    const pushed = own.filter(
      (feed) => !LINKED_FEEDS.includes(feed) || reachable.every((node) => peers.get(node)?.includes(feed)),
    );

    const key = pushed.join(",");

    if (key === sent) return;
    sent = key;
    push(create(ui.OverviewUpdateSchema, { change: { case: "feeds", value: { pushed } } }));
  };

  return {
    update,
    /** This computer's own feeds; the stream sends the combined ones instead. */
    local(pushed: readonly string[]) {
      own = pushed;
      sent = "\u0000";
      update();

      return true;
    },
    peer(nodeId: string, pushed: readonly string[]) {
      peers.set(nodeId, pushed);
      update();
    },
  };
}
