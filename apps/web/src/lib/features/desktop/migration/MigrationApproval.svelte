<script lang="ts">
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import type { DesktopMigrationApproval, DesktopMigrationReview } from "@canopy/ui/desktop";
  import Button from "#lib/shared/ui/Button.svelte";
  import ChoiceControl from "#lib/shared/ui/ChoiceControl.svelte";
  import MigrationBlockers from "./MigrationBlockers.svelte";
  import MigrationReviewSummary from "./MigrationReviewSummary.svelte";
  import { reviewKind } from "./migration-copy.ts";

  let {
    review,
    enabled,
    canAbort,
    onapprove,
  }: {
    review: DesktopMigrationReview;
    enabled: boolean;
    canAbort: boolean;
    onapprove: (approval: DesktopMigrationApproval) => void;
  } = $props();

  const choices = new SvelteMap<string, "source" | "target">();
  const approved = new SvelteSet<string>();
  const remaining = $derived(review.conflicts.length - choices.size);

  function sourceRowKey({ table, sourceKey }: { table: string; sourceKey: string }) {
    return JSON.stringify([table, sourceKey]);
  }

  const conflictBySource = $derived.by(() => {
    const conflicts = new Map<string, string>();

    for (const conflict of review.conflicts) {
      const key = sourceRowKey(conflict);

      if (!conflicts.has(key)) conflicts.set(key, conflict.id);
    }

    return conflicts;
  });

  const requiredSecrets = $derived(
    review.secrets.filter((secret) => {
      const conflictId = conflictBySource.get(sourceRowKey(secret));

      return conflictId === undefined || choices.get(conflictId) !== "target";
    }),
  );

  const approvedSecretIds = $derived(
    requiredSecrets
      .values()
      .filter((secret) => approved.has(secret.id))
      .map((secret) => secret.id)
      .toArray(),
  );

  const secretsRemaining = $derived(requiredSecrets.length - approvedSecretIds.length);
  const canImport = $derived(enabled && !review.blockers.length && !remaining && !secretsRemaining);

  function keepServerSettings(conflict: DesktopMigrationReview["conflicts"][number]) {
    choices.set(conflict.id, "target");
    const key = sourceRowKey(conflict);

    if (conflictBySource.get(key) !== conflict.id) return;

    for (const secret of review.secrets) {
      if (conflict.table === secret.table && conflict.sourceKey === secret.sourceKey) approved.delete(secret.id);
    }
  }

  function approve() {
    if (!canImport) return;
    onapprove({
      reviewDigest: review.reviewDigest,
      conflictChoices: Object.fromEntries(choices),
      approvedSecretIds,
    });
  }
</script>

<section class="grid min-w-0 gap-4" aria-labelledby="migration-review">
  <div class="grid gap-1">
    <h2 id="migration-review" class="text-lg/7 font-semibold">
      {canAbort ? "Review the final import" : "Review the updated import"}
    </h2>
    <p class="text-pretty text-muted">
      {canAbort
        ? "Canopy paused local work. Review what this computer will share with the server."
        : "The server changed since your last review. The local gateway stays paused while you review the new choices."}
    </p>
  </div>
  <MigrationReviewSummary {review} />
  {#if review.blockers.length}
    <MigrationBlockers blockers={review.blockers} final {canAbort} />
  {:else}
    {#if review.conflicts.length}
      <section class="grid min-w-0 gap-2" aria-labelledby="migration-conflicts">
        <div>
          <h3 id="migration-conflicts" class="font-medium">Conflicts</h3>
          <p class="text-pretty text-muted">Choose which side’s settings to keep for each item.</p>
        </div>
        <ul
          class="divide-y divide-divider rounded-xl bg-surface ring-1 ring-divider sm:max-h-96 sm:scroll-stable sm:overflow-y-auto"
        >
          {#each review.conflicts as conflict (conflict.id)}
            <li class="min-w-0 px-3 py-3">
              <fieldset class="min-w-0">
                <legend class="font-medium">{reviewKind(conflict.table)}</legend>
                <div class="grid gap-2 sm:grid-cols-2">
                  <label class="flex min-w-0 items-start gap-2 rounded-lg bg-panel p-2 pointer-coarse:min-h-12">
                    <span class="flex h-lh items-center">
                      <ChoiceControl
                        type="radio"
                        name={conflict.id}
                        checked={choices.get(conflict.id) === "source"}
                        onchange={() => choices.set(conflict.id, "source")}
                        disabled={!enabled}
                      />
                    </span>
                    <span class="min-w-0">
                      Keep this computer’s
                      <span class="block text-sm/5 wrap-anywhere text-muted">{conflict.sourceKey}</span>
                    </span>
                  </label>
                  <label class="flex min-w-0 items-start gap-2 rounded-lg bg-panel p-2 pointer-coarse:min-h-12">
                    <span class="flex h-lh items-center">
                      <ChoiceControl
                        type="radio"
                        name={conflict.id}
                        checked={choices.get(conflict.id) === "target"}
                        onchange={() => keepServerSettings(conflict)}
                        disabled={!enabled}
                      />
                    </span>
                    <span class="min-w-0">
                      Keep the server’s
                      <span class="block text-sm/5 wrap-anywhere text-muted">{conflict.targetKey}</span>
                    </span>
                  </label>
                </div>
              </fieldset>
            </li>
          {/each}
        </ul>
        <p role="status" class="text-muted">
          {remaining
            ? `${remaining.toLocaleString()} ${remaining === 1 ? "conflict" : "conflicts"} left`
            : "All conflicts resolved"}
        </p>
      </section>
    {/if}
    {#if review.secrets.length}
      <section class="grid min-w-0 gap-2" aria-labelledby="migration-secrets">
        <div>
          <h3 id="migration-secrets" class="font-medium">Secrets</h3>
          {#if requiredSecrets.length}
            <p class="text-pretty text-muted">
              Confirm each secret the selected settings need. Canopy encrypts these secrets for the server.
            </p>
          {:else}
            <p class="text-pretty text-muted">The selected settings require no secrets from this computer.</p>
          {/if}
        </div>
        {#if requiredSecrets.length}
          <ul
            class="divide-y divide-divider rounded-xl bg-surface ring-1 ring-divider sm:max-h-72 sm:scroll-stable sm:overflow-y-auto"
          >
            {#each requiredSecrets as secret (secret.id)}
              <li class="px-3 py-2">
                <label class="flex min-w-0 items-start gap-3 pointer-coarse:min-h-11">
                  <span class="flex h-lh items-center">
                    <ChoiceControl
                      checked={approved.has(secret.id)}
                      disabled={!enabled}
                      onchange={(event) =>
                        event.currentTarget.checked ? approved.add(secret.id) : approved.delete(secret.id)}
                    />
                  </span>
                  <span class="min-w-0">
                    {reviewKind(secret.table)}
                    <span class="block text-sm/5 wrap-anywhere text-muted">{secret.sourceKey}</span>
                  </span>
                </label>
              </li>
            {/each}
          </ul>
          <p role="status" class="text-muted">
            {secretsRemaining
              ? `${secretsRemaining.toLocaleString()} ${secretsRemaining === 1 ? "secret" : "secrets"} left to confirm`
              : "All required secrets confirmed"}
          </p>
        {/if}
      </section>
    {/if}
    {#if !review.conflicts.length && !review.secrets.length}
      <p class="text-pretty text-muted">There are no conflicts or secrets to review.</p>
    {/if}
    <p class="text-pretty text-muted">
      Devices connected to the server’s Canopy account can see the imported data. Pair devices that used this gateway
      again after the import.
    </p>
    <div><Button variant="primary" onclick={approve} disabled={!canImport}>Import data</Button></div>
  {/if}
</section>
