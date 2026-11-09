import { useState } from "react";
import { awayReason, computerName } from "@canopy/domain/computer-presence";
import { MOVE_ITEMS, splitId } from "@canopy/domain/computers";
import { Notice, Sheet } from "../../ui/components";
import { useSession } from "../../state/session";
import { SettingChoice } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { ComputerMove, type MoveItem } from "./ComputerMove";
import { presenceTime } from "../computers/presence";

export function ItemComputerMove({ item, onClose }: { item: MoveItem; onClose: () => void }) {
  const { online } = useSession();
  const resource = useSettingsResource("GetComputers", (api) => api.getComputers({}));
  const [target, setTarget] = useState("");
  const targets = resource.data?.peers.filter((peer) => !peer.viaNodeId) ?? [];
  const local = !splitId(item.id).node;

  return (
    <Sheet title="Move to a computer" visible onClose={onClose}>
      <ResourceState resource={resource}>
        {!local ? (
          <Notice>Open this item on its home computer to move it.</Notice>
        ) : (
          <>
            <SettingChoice
              title="Move to"
              value={target}
              onChange={setTarget}
              disabled={!online}
              options={[
                { value: "", label: "Choose a computer" },
                ...targets.map((peer) => ({
                  value: peer.nodeId,
                  label: computerName(peer),
                  disabled: Boolean(awayReason(peer, presenceTime)) || !peer.capabilities.includes(MOVE_ITEMS),
                  description:
                    awayReason(peer, presenceTime) ||
                    (!peer.capabilities.includes(MOVE_ITEMS) ? "Update this computer to receive moves." : "Connected"),
                })),
              ]}
            />
            {resource.data && !targets.length && <Notice>Link another computer in Settings → Computers first.</Notice>}
            {target && online && <ComputerMove key={target} nodeId={target} items={[item]} onOpened={onClose} />}
          </>
        )}
      </ResourceState>
    </Sheet>
  );
}
