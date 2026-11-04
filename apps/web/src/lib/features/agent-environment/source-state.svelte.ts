import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import type { EnvironmentState } from "./environment-state.svelte.ts";

export class SourceState {
  preview = $state.raw<ui.SkillSourcePreview>();
  busy = $state(false);
  error = $state("");
  paths = $state<string[]>([]);
  assignment = $state(
    create(ui.LibrarySkillSchema, {
      harnesses: ["claude", "codex", "grok"],
      platformHome: true,
      selector: { everyone: true },
    }),
  );
  revision = 0n;

  constructor(readonly environment: EnvironmentState) {}

  async resolve(command: string, credentialAccountId: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    this.preview = undefined;

    try {
      this.preview = decode(
        ui.SkillSourcePreviewSchema,
        await requestJson(
          "POST",
          "/api/agent-environment/skills/source/preview",
          encode(
            ui.PreviewSkillSourceRequestSchema,
            create(ui.PreviewSkillSourceRequestSchema, { command, credentialAccountId }),
          ),
          130_000,
        ),
      );
      this.paths = this.preview.skills.map((s) => s.path);
      this.assignment.harnesses = this.preview.harnesses;
      this.assignment.deviceHome = this.preview.deviceHome;
      this.revision = this.environment.snapshot.revision;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Couldn't preview the source.";
    } finally {
      this.busy = false;
    }
  }

  async check(id: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    this.preview = undefined;

    try {
      const result = await requestJson(
        "POST",
        "/api/agent-environment/skills/source/check",
        encode(ui.CheckSkillSourceRequestSchema, create(ui.CheckSkillSourceRequestSchema, { id })),
        130_000,
      );

      const snapshot = await this.environment.refresh();

      if (!snapshot) throw new Error("Couldn't refresh the environment. Check upstream again.");
      this.preview = decode(ui.SkillSourcePreviewSchema, result);
      // An overview refresh can still be in flight and supersede the displayed snapshot.
      // Use the revision returned by our completed read, rather than that older display.
      this.revision = snapshot.revision;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Couldn't check upstream.";
    } finally {
      this.busy = false;
    }
  }

  async add(): Promise<void> {
    if (!this.preview || this.busy) return;

    if (
      await this.environment.mutate(
        "POST",
        "/skills/source/add",
        encode(
          ui.AddSkillSourceRequestSchema,
          create(ui.AddSkillSourceRequestSchema, {
            previewId: this.preview.id,
            paths: this.paths,
            assignment: this.assignment,
            expectedRevision: this.revision,
          }),
        ),
      )
    ) {
      this.preview = undefined;
      this.environment.notice = "Skills added. Assigned computers will sync the reviewed commit.";
    }
  }

  async apply(id: string): Promise<void> {
    if (!this.preview || this.busy) return;

    if (
      await this.environment.mutate(
        "POST",
        "/skills/source/apply",
        encode(
          ui.ApplySkillSourceRequestSchema,
          create(ui.ApplySkillSourceRequestSchema, { id, previewId: this.preview.id, expectedRevision: this.revision }),
        ),
      )
    ) {
      this.preview = undefined;
      this.environment.notice = "Update applied. Assigned computers will sync the reviewed version.";
    }
  }
}
