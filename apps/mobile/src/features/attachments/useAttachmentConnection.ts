import { splitId } from "@canopy/domain/computers";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";

/** A mounted preview retries when its home reconnects or this phone's transport resets. */
export function useAttachmentConnection(id: string) {
  const { computers } = useOverview();
  const { epoch } = useSession();
  const node = splitId(id).node;
  const computer = node && computers.find((computer) => computer.nodeId.startsWith(node));

  return `${epoch}:${computer ? computer.status : ""}`;
}
