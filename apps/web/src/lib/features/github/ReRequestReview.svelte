<script lang="ts">
  import { untrack } from "svelte";
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { metadataEditor } from "./metadata-editors.ts";
  import { invalidations } from "./invalidations.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";

  let {
    snapshot,
    id,
    class: className,
  }: { snapshot: github.PullRequestSnapshot; id: string; class?: ClassValue } = $props();

  const editor = $derived(metadataEditor(snapshot, "reviewers"));

  let f = $state(untrack(() => editor.read())),
    online = $state(true);

  $effect(() => {
    const target = editor;
    f = target.read();

    return target.subscribe(() => (f = target.read()));
  });

  $effect(() => {
    const update = () => (online = navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);

    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  });

  async function request() {
    if (await editor.reRequest(id)) {
      invalidations.publish(snapshot.summary?.ref?.id ?? "");
      invalidations.publish(`${snapshot.summary?.ref?.id}:metadata`);
      toast("Review requested.");
    } else if (editor.state.detail) toast(editor.state.detail, { tone: "error" });
  }
</script>

<div class={["shrink-0", className]}>
  <IconButton
    icon="arrow-path"
    size="sm"
    label="Re-request review"
    disabled={!online ||
      snapshot.stale ||
      f.busy ||
      !!f.conflict ||
      !!(f.receipt && ["uncertain", "in_flight"].includes(f.receipt.state))}
    onclick={() => void request()}
  />
</div>
