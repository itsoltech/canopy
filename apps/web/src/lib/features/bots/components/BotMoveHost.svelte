<script lang="ts">
  import { onMount } from "svelte";
  import MoveDialog from "#lib/features/computers/MoveDialog.svelte";
  import { botList } from "../bot-list.svelte.ts";

  /** "Move to…" for a bot from any menu: the `move-bot` window event names it (like `delete-bot`). */
  let botId = $state("");
  let open = $state(false);
  // Kept from the moment it opens: the bot leaves this computer's list when it moves.
  let name = $state("");
  onMount(() => {
    const move = (event: Event) => {
      botId = String((event as CustomEvent<string>).detail);
      name = botList.list.find((b) => b.id === botId)?.configuration?.name || "Bot";
      open = true;
    };
    window.addEventListener("move-bot", move);
    return () => window.removeEventListener("move-bot", move);
  });
</script>

<MoveDialog bind:open items={botId ? [{ kind: "bot", id: botId }] : []} {name} />
