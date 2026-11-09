import { clone, create } from "@bufbuild/protobuf";
import { ui, type EnvironmentFileStatus } from "@canopy/contracts";
import { HttpError, requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import { revealEnvironmentItem } from "./environment-feedback.ts";
import { sharedRead, type SharedRead } from "#lib/shared/queries.svelte.ts";

/** The library and every worker's view of it, shared by the tab (Agent environment and Workers pages). */
export const sharedEnvironment = () =>
  sharedRead("GetAgentEnvironment", ui.AgentEnvironmentSnapshotSchema, "/api/agent-environment");

export class EnvironmentState {
  #local = $state.raw<ui.AgentEnvironmentSnapshot>(create(ui.AgentEnvironmentSnapshotSchema));
  draft = $state<ui.InstructionDocument | undefined>();
  workerId = $state("");
  error = $state("");
  notice = $state("");
  busy = $state(false);
  editConflict = $state(false);
  #editRevision = 0n;

  constructor(
    initial: ui.AgentEnvironmentSnapshot = create(ui.AgentEnvironmentSnapshotSchema),
    private readonly shared: SharedRead<ui.AgentEnvironmentSnapshot> = sharedEnvironment(),
  ) {
    this.#local = initial;
    this.workerId = this.#local.workers[0]?.workerId ?? "";
  }

  get loaded(): boolean {
    return this.shared.snapshot.loaded;
  }

  /** The newest revision known: the shared read, or a route's initial value until it arrives. */
  get snapshot(): ui.AgentEnvironmentSnapshot {
    const shared = this.shared.data;

    return shared && shared.revision >= this.#local.revision ? shared : this.#local;
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
    try {
      return await this.shared.reload();
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
      const saved = decode(ui.AgentEnvironmentSnapshotSchema, response);

      if (saved.revision >= this.snapshot.revision) this.shared.set(saved);
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
