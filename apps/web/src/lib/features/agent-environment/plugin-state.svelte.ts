import { clone, create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { pluginHarnesses } from "@canopy/domain/plugin-components";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import type { EnvironmentState } from "./environment-state.svelte.ts";

export class PluginState {
  preview = $state.raw<ui.MarketplacePreview>();
  busy = $state(false);
  error = $state("");
  draft = $state<ui.LibrarySkill>();
  marketplace = $state.raw<ui.EnvironmentMarketplace>();
  candidate = $state.raw<ui.MarketplacePlugin>();
  previous = $state.raw<ui.LibraryPlugin>();
  confirmed = $state(false);
  latest = $state(false);
  revision = 0n;
  previewRevision = 0n;
  constructor(readonly environment: EnvironmentState) {}

  async resolve(command: string, credentialAccountId: string, id = "") {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    this.preview = undefined;

    try {
      this.preview = decode(
        ui.MarketplacePreviewSchema,
        await requestJson(
          "POST",
          "/api/agent-environment/marketplaces/preview",
          encode(
            ui.PreviewMarketplaceRequestSchema,
            create(ui.PreviewMarketplaceRequestSchema, { command, credentialAccountId, id }),
          ),
          130_000,
        ),
      );
      this.previewRevision = this.environment.snapshot.revision;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Couldn't preview marketplace.";
    } finally {
      this.busy = false;
    }
  }

  async saveMarketplace() {
    if (!this.preview) return;

    if (
      await this.environment.mutate(
        "POST",
        "/marketplaces",
        encode(
          ui.SaveMarketplaceRequestSchema,
          create(ui.SaveMarketplaceRequestSchema, {
            previewId: this.preview.id,
            expectedRevision: this.previewRevision,
          }),
        ),
      )
    ) {
      this.preview = undefined;
      this.environment.notice =
        "Marketplace saved. Review a plugin below to enable it. Enabled plugins keep their approved versions.";
    }
  }

  catalog(market: ui.EnvironmentMarketplace) {
    const missing = this.environment.snapshot.plugins.filter(
      (p) =>
        p.marketplaceId === market.id &&
        !market.plugins.some((candidate) => candidate.artifact?.name === p.assignment?.artifact?.name),
    );

    return [
      ...market.plugins,
      ...missing.map((p) =>
        create(ui.MarketplacePluginSchema, {
          artifact: p.assignment?.artifact,
          harnesses: pluginHarnesses(p.assignment?.artifact?.files ?? []),
        }),
      ),
    ];
  }

  edit(market: ui.EnvironmentMarketplace, candidate: ui.MarketplacePlugin) {
    const previous = this.environment.snapshot.plugins.find(
      (p) => p.marketplaceId === market.id && p.assignment?.artifact?.name === candidate.artifact?.name,
    );

    this.marketplace = market;
    this.candidate = candidate;
    this.previous = previous;
    this.draft = previous?.assignment
      ? clone(ui.LibrarySkillSchema, previous.assignment)
      : create(ui.LibrarySkillSchema, {
          name: candidate.artifact?.name,
          harnesses: candidate.harnesses,
          platformHome: true,
          selector: { everyone: true },
        });
    this.latest = !previous;
    this.confirmed = false;
    this.revision = this.environment.snapshot.revision;
  }

  command(command: string) {
    const match = command
      .trim()
      .match(/^(?:\/plugin install |claude plugin install |codex plugin add )?([a-z0-9-]+)@([a-z0-9-]+)$/);

    const market = this.environment.snapshot.marketplaces.find((m) => m.name === match?.[2]);
    const candidate = market ? this.catalog(market).find((p) => p.artifact?.name === match?.[1]) : undefined;

    if (
      !market ||
      !candidate ||
      (candidate.unavailableReason &&
        !this.environment.snapshot.plugins.some(
          (p) => p.marketplaceId === market.id && p.assignment?.artifact?.name === candidate.artifact?.name,
        ))
    ) {
      this.error = "Add the marketplace first, then paste /plugin install name@marketplace.";

      return;
    }

    this.error = "";
    this.edit(market, candidate);
  }

  async savePlugin() {
    if (!this.draft || !this.candidate?.artifact || !this.marketplace || !this.confirmed) return;
    const artifact = this.latest ? this.candidate.artifact : this.previous?.assignment?.artifact;

    if (
      await this.environment.mutate(
        "POST",
        "/plugins",
        encode(
          ui.SaveLibraryPluginRequestSchema,
          create(ui.SaveLibraryPluginRequestSchema, {
            marketplaceId: this.marketplace.id,
            pluginName: `${this.candidate.artifact.name}@${this.marketplace.name}`,
            assignment: this.draft,
            confirmedChecksum: artifact?.checksum,
            useLatest: this.latest,
            expectedRevision: this.revision,
          }),
        ),
      )
    ) {
      this.draft = undefined;
      this.environment.notice =
        "Plugin approved and assigned. New harness sessions will load the reviewed version after sync.";
    }
  }

  async removePlugin(id: string) {
    await this.environment.mutate(
      "DELETE",
      "/plugins",
      encode(
        ui.DeleteLibraryPluginRequestSchema,
        create(ui.DeleteLibraryPluginRequestSchema, { id, expectedRevision: this.environment.snapshot.revision }),
      ),
    );
  }

  async removeMarketplace(id: string) {
    await this.environment.mutate(
      "DELETE",
      "/marketplaces",
      encode(
        ui.DeleteMarketplaceRequestSchema,
        create(ui.DeleteMarketplaceRequestSchema, { id, expectedRevision: this.environment.snapshot.revision }),
      ),
    );
  }
}
