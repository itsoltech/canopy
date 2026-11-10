import { retain } from "@canopy/domain/same-items";
import { sameSubagents } from "@canopy/domain/subagents";

export {
  isActiveSubagent,
  subagentLook,
  subagentState,
  subagentsOf,
  subagentSummary,
  type Subagent,
  type SubagentState,
} from "@canopy/domain/subagents";

/** Every thread event rebuilds the index: the tray reruns only when a subagent or its state changed. */
export const retainSubagents = () => retain(sameSubagents);
