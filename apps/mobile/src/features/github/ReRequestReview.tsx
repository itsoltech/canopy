import type { github } from "@canopy/contracts";
import { useMetadataEditor } from "./useMetadataEditor";
import { IconAction } from "./IconAction";
import { invalidations } from "./invalidations";
import { toast } from "../../ui/Toast";

export function ReRequestReview({ snapshot, id }: { snapshot: github.PullRequestSnapshot; id: string }) {
  const { editor, blocked } = useMetadataEditor(snapshot, "reviewers");

  async function request() {
    if (await editor?.reRequest(id)) {
      invalidations.publish(snapshot.summary?.ref?.id ?? "");
      invalidations.publish(`${snapshot.summary?.ref?.id}:metadata`);
      toast("Review requested.");
    } else if (editor?.state.detail) toast(editor.state.detail);
  }

  return <IconAction icon="arrow-path" label="Re-request review" disabled={blocked} onPress={() => void request()} />;
}
