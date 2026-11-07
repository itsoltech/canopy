import { clone, create, fromJson, toJson } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { GatewayCore } from "../core/core.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { MODE_LABELS, MODES, PROVIDERS } from "./library.ts";
import { documents } from "../agent-environment/database.ts";
import { applyMarketplace, applySkill, undoMarketplace, undoSkill, type Applied } from "./library-apply-skills.ts";
import { libraryReceipt, type LibraryRow } from "./library-store.ts";

/**
 * Applying and undoing settings and library items (docs/import.md, "Ustawienia i biblioteka"). Each change records
 * what was there before, in the transaction that makes the change; Undo restores it only if nobody changed the item
 * since (otherwise the item is "kept").
 * Instruction documents go to Canopy's platform homes on the source worker only, never to the device's CLI files.
 */

const READ_TIMEOUT_MS = 60_000;

export type { Applied };

const SettingTarget = Schema.Struct({
  setting: Schema.Literals(["model", "permissions"]),
  provider: Schema.Number,
  previous: Schema.Union([Schema.String, Schema.Number]),
  applied: Schema.Union([Schema.String, Schema.Number]),
});

const DocumentTarget = Schema.Struct({
  documentId: Schema.String,
  revision: Schema.String,
  previous: Schema.optional(Schema.MutableJson),
});

const decodeSetting = Schema.decodeUnknownOption(SettingTarget);
const decodeDocument = Schema.decodeUnknownOption(DocumentTarget);

export class LibraryApply {
  readonly #core: GatewayCore;

  constructor(core: GatewayCore) {
    this.#core = core;
  }

  /** Makes the change; the item becomes done with its receipt in the same transaction. */
  async apply(row: LibraryRow): Promise<void> {
    if (row.kind === "instruction") return this.#document(row);

    if (row.kind === "skill" || row.kind === "command") return applySkill(this.#core, row);

    if (row.kind === "marketplace") return applyMarketplace(this.#core, row);

    return this.#setting(row);
  }

  /**
   * Restores what the item replaced, unless it changed after the import ("kept"); the item's new state commits with
   * the restore. An item whose change is already gone is undone without a change.
   */
  async undo(row: LibraryRow): Promise<void> {
    if (row.kind === "instruction") return this.#undoDocument(row);

    if (row.kind === "skill" || row.kind === "command") return undoSkill(this.#core, row);

    if (row.kind === "marketplace") return undoMarketplace(this.#core, row);
    const target = Option.getOrUndefined(decodeSetting(row.target));

    if (!target) return this.#mark(row, "undone");
    const { user } = await this.#core.settings();
    const defaults = clone(ui.ThreadDefaultsSchema, user?.threadDefaults ?? create(ui.ThreadDefaultsSchema));
    const { setting, provider, previous, applied } = target;

    if (setting === "model") {
      const models = defaults.models.filter((m) => m.provider !== provider);

      if ((defaults.models.find((m) => m.provider === provider)?.model ?? "") !== applied)
        return this.#mark(row, "kept");
      defaults.models = previous
        ? [...models, create(ui.ProviderModelSchema, { provider, model: String(previous) })]
        : models;
    } else {
      if (defaults.permissionMode !== applied) return this.#mark(row, "kept");
      defaults.permissionMode = Number(previous);
    }

    await this.#core.updateUserSettings(
      create(ui.UpdateUserSettingsRequestSchema, { threadDefaults: defaults, expectedVersion: user?.version ?? 0n }),
      { receipt: libraryReceipt(row, "undone") },
    );
  }

  /** A state change that comes with no change in Canopy. */
  async #mark(row: LibraryRow, status: "undone" | "kept"): Promise<void> {
    await this.#core.imports.sql((sql) => libraryReceipt(row, status)(sql));
  }

  async #setting(row: LibraryRow): Promise<void> {
    const { user } = await this.#core.settings();
    const defaults = clone(ui.ThreadDefaultsSchema, user?.threadDefaults ?? create(ui.ThreadDefaultsSchema));
    const provider = PROVIDERS.get(row.agent_cli) ?? Provider.UNSPECIFIED;
    let target: Applied["target"];
    let detail: string;

    if (row.name === "model") {
      const previous = defaults.models.find((m) => m.provider === provider)?.model ?? "";
      defaults.models = [
        ...defaults.models.filter((m) => m.provider !== provider),
        create(ui.ProviderModelSchema, { provider, model: row.value }),
      ];
      target = { setting: "model", provider, previous, applied: row.value };
      detail = row.value;
    } else {
      const mode = MODES.get(row.value);

      // Never Full access, whatever the source says (docs/import.md, "Ustawienia").
      if (mode === undefined || mode === PermissionMode.FULL_ACCESS) throw new Error("Canopy has no matching mode.");
      target = { setting: "permissions", provider, previous: defaults.permissionMode, applied: mode };
      defaults.permissionMode = mode;
      detail = MODE_LABELS.get(mode) ?? row.value;
    }

    await this.#core.updateUserSettings(
      create(ui.UpdateUserSettingsRequestSchema, { threadDefaults: defaults, expectedVersion: user?.version ?? 0n }),
      { receipt: libraryReceipt(row, "done", { target, detail }) },
    );
  }

  async #document(row: LibraryRow): Promise<void> {
    const result = await coreWorkerQuery(
      this.#core,
      row.worker_id,
      { case: "readImportLibraryItem", value: { sourceKey: row.source_key, digest: row.digest } },
      READ_TIMEOUT_MS,
    );

    const content = result.importLibraryContent?.text;

    if (content === undefined) throw new Error("The worker did not return the file.");
    const environment = this.#core.environment;
    const snapshot = await environment.snapshot();
    const existing = snapshot.documents.find((d) => d.name === row.label && d.harness === row.agent_cli);
    const fragment = create(ui.InstructionFragmentSchema, { id: crypto.randomUUID(), name: row.name, content });
    const owner = row.owner_user_id;

    // The receipt finds the saved document by its new fragment, in the transaction that saved it.
    const receipt = (extra: (saved: ui.InstructionDocument) => Applied) => (sql: SqlClient.SqlClient) =>
      Effect.gen(function* () {
        const saved = (yield* documents(sql, owner)).find((d) => d.fragments.some((f) => f.id === fragment.id));

        if (!saved) return yield* Effect.die(new Error("The document was not saved."));
        yield* libraryReceipt(row, "done", extra(saved))(sql);
      }).pipe(Effect.orDie);

    if (existing && row.action === "replace") {
      const document = clone(ui.InstructionDocumentSchema, existing);
      document.fragments = [fragment];
      await environment.save(
        create(ui.SaveInstructionDocumentRequestSchema, { document, expectedRevision: snapshot.revision }),
        receipt((saved) => ({
          target: {
            documentId: saved.id,
            revision: String(saved.revision),
            previous: toJson(ui.InstructionDocumentSchema, existing),
          },
          detail: "Replaced in Agent environment",
        })),
      );

      return;
    }

    const name = existing ? freeName(row.label, snapshot.documents) : row.label;

    const document = create(ui.InstructionDocumentSchema, {
      name,
      harness: row.agent_cli,
      selector: { workerIds: [row.worker_id] },
      fragments: [fragment],
      // Canopy's own homes of the source worker: the device's CLI files stay the user's.
      platformHome: true,
      deviceHome: false,
    });

    await environment.save(
      create(ui.SaveInstructionDocumentRequestSchema, { document, expectedRevision: snapshot.revision }),
      receipt((saved) => ({
        target: { documentId: saved.id, revision: String(saved.revision) },
        detail: name === row.label ? "Added to Agent environment" : `Added to Agent environment as ${name}`,
      })),
    );
  }

  async #undoDocument(row: LibraryRow): Promise<void> {
    const target = Option.getOrUndefined(decodeDocument(row.target));

    if (!target) return this.#mark(row, "undone");
    const environment = this.#core.environment;
    const snapshot = await environment.snapshot();
    const document = snapshot.documents.find((d) => d.id === target.documentId);

    if (!document) return this.#mark(row, "undone");

    if (String(document.revision) !== target.revision) return this.#mark(row, "kept");

    if (target.previous !== undefined) {
      const previous = fromJson(ui.InstructionDocumentSchema, target.previous);
      await environment.save(
        create(ui.SaveInstructionDocumentRequestSchema, { document: previous, expectedRevision: snapshot.revision }),
        libraryReceipt(row, "undone"),
      );
    } else
      await environment.remove(
        create(ui.DeleteInstructionDocumentRequestSchema, { id: document.id, expectedRevision: snapshot.revision }),
        libraryReceipt(row, "undone"),
      );
  }
}

/** "Name (2)", "Name (3)", … : the first name no document has. */
function freeName(name: string, documents: readonly ui.InstructionDocument[]): string {
  const taken = new Set(documents.map((d) => d.name));

  for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`)) return `${name} (${n})`;
}
