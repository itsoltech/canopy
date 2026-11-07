import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { Sheet } from "../../ui/components";
import { SubagentLineage } from "./SubagentLineage";

export function SubagentSheet({
  threads,
  visible,
  onClose,
}: {
  threads: readonly ui.Thread[];
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet title="Subagents" visible={visible} onClose={onClose}>
      <SubagentLineage
        threads={threads}
        onOpen={(id) => {
          onClose();
          router.push({ pathname: "/thread/[id]", params: { id } });
        }}
      />
    </Sheet>
  );
}
