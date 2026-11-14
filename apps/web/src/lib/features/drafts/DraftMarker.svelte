<script lang="ts">
  import { webDrafts } from "./local.svelte.ts";
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { remoteDrafts } from "./remote.svelte.ts";

  let { threadId }: { threadId: string } = $props();
  let present = $state(false);

  $effect(() => {
    void webDrafts.generation;
    const target = create(ui.ComposerDraftTargetSchema, { threadId });

    const update = () => {
      present = Boolean(webDrafts.local.get(target));
    };

    update();

    return webDrafts.local.subscribeKey(target, update);
  });
</script>

<!-- The slot is always reserved, on the side away from the title's alignment edge. -->
<span class="inline-flex w-8 shrink-0 justify-end" aria-hidden={!present && !remoteDrafts.threadIds.includes(threadId)}>
  <span class:invisible={!present && !remoteDrafts.threadIds.includes(threadId)}>Draft</span>
</span>
