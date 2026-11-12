<script lang="ts">
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { uniqueEntries } from "@canopy/domain/release/note-range";
  import WhatsNewEntries from "./WhatsNewEntries.svelte";
  import { whatsNew as notes } from "./whats-new.svelte.ts";
</script>

<Dialog bind:open={notes.open} title="What's new">
  <div class="grid min-w-0 gap-5">
    <div class="grid gap-2">
      <p class="break-anywhere text-sm/5 text-muted tabular-nums">
        {notes.recent || !notes.previous ? `Canopy ${notes.current}` : `From ${notes.previous} to ${notes.current}`}
      </p>
      {#if notes.previous}
        <div class="flex flex-wrap gap-2" role="group" aria-label="Release notes view">
          <Button size="sm" aria-pressed={!notes.recent} onclick={() => (notes.recent = false)}>Since update</Button>
          <Button size="sm" aria-pressed={notes.recent} onclick={() => (notes.recent = true)}>Recent releases</Button>
        </div>
      {/if}
    </div>
    {#if notes.pending}<p class="text-base/6 text-muted sm:text-sm/6" role="status">Loading release notes…</p>
    {:else if notes.error}<div class="grid gap-2">
        <p class="text-base/6 text-pretty text-muted sm:text-sm/6" role="status">{notes.error}</p>
        <div><Button size="sm" onclick={() => notes.load()}>Retry</Button></div>
      </div>
    {:else if notes.index}
      {#if notes.recent}
        {#if !notes.index.releases.some((release) => release.version === notes.current) && notes.releases.length}
          <p class="text-base/6 text-pretty text-muted sm:text-sm/6" role="status">
            Notes for this version are not available yet. Retry or view releases on GitHub.
          </p>
          <div><Button size="sm" onclick={() => notes.load()}>Retry</Button></div>
        {/if}
        {#each notes.releases as release, i (release.version)}
          <Disclosure open={i === 0} summaryClass="py-1 text-sm/5">
            {#snippet summary()}<span class="break-anywhere font-medium tabular-nums">{release.version}</span>
              <span class="text-muted">
                · {new Date(release.date).toLocaleDateString(undefined, { dateStyle: "medium" })}</span
              >{/snippet}
            <WhatsNewEntries entries={uniqueEntries([release])} class="pt-3 pb-2" />
          </Disclosure>
        {:else}<p class="text-base/6 text-pretty text-muted sm:text-sm/6">
            Release notes are not available yet. Retry or view releases on GitHub.
          </p>
          <div><Button size="sm" onclick={() => notes.load()}>Retry</Button></div>
        {/each}
      {:else if notes.range}
        {#if notes.range.incomplete}<p class="text-base/6 text-pretty text-muted sm:text-sm/6" role="status">
            Some release notes are not available yet. Retry or view releases on GitHub.
          </p>
          <div><Button size="sm" onclick={() => notes.load()}>Retry</Button></div>{/if}
        <WhatsNewEntries entries={notes.range.entries} />
      {/if}
    {/if}
  </div>
  {#snippet footer()}<div class="text-sm/5">
      <TextLink href="https://github.com/itsoltech/canopy/releases" target="_blank" rel="noreferrer"
        >View all releases on GitHub</TextLink
      >
    </div>{/snippet}
</Dialog>
