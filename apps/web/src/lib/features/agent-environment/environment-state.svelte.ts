import { clone, create } from "@bufbuild/protobuf";
import { ui, type EnvironmentFileStatus } from "@canopy/contracts";
import { HttpError, requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import type { JsonValue } from "#lib/shared/json.ts";
import { revealEnvironmentItem } from "./environment-feedback.ts";

export class EnvironmentState {
  snapshot = $state.raw<ui.AgentEnvironmentSnapshot>(create(ui.AgentEnvironmentSnapshotSchema));
  draft = $state<ui.InstructionDocument | undefined>();
  workerId = $state("");
  error = $state("");
  notice = $state("");
  busy = $state(false);
  editConflict = $state(false);
  loaded = $state(false);
  #refresh = 0;
  #editRevision = 0n;

  constructor(initial: JsonValue = {}) {
    this.snapshot = decode(ui.AgentEnvironmentSnapshotSchema, initial);
    this.workerId = this.snapshot.workers[0]?.workerId ?? "";
  }

  edit(document?: ui.InstructionDocument): void {
    this.error = "";
    this.notice = "";
    this.editConflict = false;
    this.#editRevision = this.snapshot.revision;
    this.draft = document
      ? clone(ui.InstructionDocumentSchema, document)
      : create(ui.InstructionDocumentSchema, {
          name: "",
          harness: "claude",
          selector: { everyone: true },
          deviceHome: true,
          platformHome: true,
          fragments: [{ id: crypto.randomUUID(), name: "Base instructions", content: "" }],
        });
  }

  async refresh(): Promise<ui.AgentEnvironmentSnapshot | undefined> {
    const sequence = ++this.#refresh;

    try {
      const result = decode(ui.AgentEnvironmentSnapshotSchema, await requestJson("GET", "/api/agent-environment"));

      if (sequence === this.#refresh && result.revision >= this.snapshot.revision) {
        this.snapshot = result;
        this.loaded = true;
      }

      return result;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Couldn't refresh the environment.";
    }
  }

  async save(): Promise<void> {
    if (!this.draft || this.editConflict) return;
    const previousIds = new Set(this.snapshot.documents.map((d) => d.id));
    const id = this.draft.id;

    const body = create(ui.SaveInstructionDocumentRequestSchema, {
      document: this.draft,
      expectedRevision: this.#editRevision,
    });

    if (await this.mutate("POST", "", encode(ui.SaveInstructionDocumentRequestSchema, body))) {
      this.draft = undefined;
      this.notice = "Saved. Assigned computers will sync, including those currently offline.";
      void revealEnvironmentItem(id || this.snapshot.documents.find((d) => !previousIds.has(d.id))?.id || "");
    } else if (this.snapshot.revision !== this.#editRevision) {
      this.editConflict = true;
    }
  }

  reloadDraft(): void {
    const document = this.snapshot.documents.find((d) => d.id === this.draft?.id);
    this.edit(document);
  }

  async remove(document: ui.InstructionDocument): Promise<void> {
    const body = create(ui.DeleteInstructionDocumentRequestSchema, {
      id: document.id,
      expectedRevision: this.snapshot.revision,
    });

    await this.mutate("DELETE", "", encode(ui.DeleteInstructionDocumentRequestSchema, body));
  }

  async resolve(file: EnvironmentFileStatus, action: string): Promise<void> {
    const body = create(ui.ResolveEnvironmentDriftRequestSchema, {
      workerId: this.workerId,
      targetId: file.targetId,
      action,
      observedChecksum: file.observedChecksum,
      expectedRevision: this.snapshot.revision,
    });

    await this.mutate("POST", "/resolve", encode(ui.ResolveEnvironmentDriftRequestSchema, body));
  }

  async mutate(method: "POST" | "DELETE", path: string, body: ReturnType<typeof encode>): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    this.error = "";
    this.notice = "";

    try {
      const response = await requestJson(method, `/api/agent-environment${path}`, body);
      this.#refresh++;
      const saved = decode(ui.AgentEnvironmentSnapshotSchema, response);

      if (saved.revision >= this.snapshot.revision) this.snapshot = saved;
      // A worker can acknowledge while the mutation response is still in flight. Fetch after it so
      // an older response cannot replace the report already delivered by the overview stream.
      await this.refresh();

      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Couldn't save the environment.";

      if (error instanceof HttpError && error.status === 409) await this.refresh();

      return false;
    } finally {
      this.busy = false;
    }
  }
}
