import { create } from "@bufbuild/protobuf";
import { EnvironmentInstructionSchema, ui, type Hello } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { environmentSelected as selected } from "@canopy/domain/environment-selectors";

export { environmentSelected as selected } from "@canopy/domain/environment-selectors";

import {
  ENVIRONMENT_BEGIN,
  ENVIRONMENT_END,
  ENVIRONMENT_CONTENT_BYTES,
  INSTRUCTION_DOCUMENT_NAME_LENGTH,
  environmentDigest,
} from "@canopy/domain/agent-environment";

export const uuid = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export const harnesses = ["claude", "codex"] as const;

export const invalid = (message: string): never => {
  throw new ConnectError(message, Code.InvalidArgument);
};

export function automaticTags(hello: Hello): string[] {
  const os = hello.host?.os ?? "unknown";
  let normalized = os;

  if (os === "darwin") normalized = "macos";

  if (os === "win32") normalized = "windows";

  const tags = [
    `os:${normalized}`,
    `arch:${hello.host?.arch || "unknown"}`,
    `hostname:${(hello.host?.hostname || "unknown").toLowerCase().slice(0, 180)}`,
    `kind:${hello.environmentKind === "desktop" ? "desktop" : "server"}`,
  ];

  for (const provider of hello.providers) {
    const name = ["", "claude", "codex", "grok"][provider.provider];

    if (provider.available && name) tags.push(`cli:${name}`);
  }

  return [...new Set(tags)].sort();
}

export function manualTags(tags: readonly string[]): string[] {
  if (tags.length > 32) invalid("Use at most 32 manual tags.");

  for (const tag of tags)
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag))
      invalid("Manual tags use lowercase letters, digits, dots, hyphens and underscores (up to 64 characters).");

  return [...new Set(tags)].sort();
}

export function compose(documents: readonly ui.InstructionDocument[], worker: ui.EnvironmentWorker) {
  return harnesses.flatMap((harness) =>
    [false, true].map((device) => {
      const parts: string[] = [];

      for (const doc of documents) {
        if (doc.harness !== harness || !(device ? doc.deviceHome : doc.platformHome) || !selected(doc.selector, worker))
          continue;
        const override = doc.overrides.find((o) => o.workerId === worker.workerId);

        if (override?.disabled) continue;

        for (const fragment of doc.fragments)
          if (selected(fragment.selector, worker) && fragment.content.trim()) parts.push(fragment.content);

        if (override?.content.trim()) parts.push(override.content);
      }

      const content = parts.join("\n\n").replaceAll("\r\n", "\n");

      if (Buffer.byteLength(content) > ENVIRONMENT_CONTENT_BYTES)
        invalid(`Instructions for ${worker.name} exceed 24 KiB. Split or shorten the matching fragments.`);

      return create(EnvironmentInstructionSchema, {
        harness,
        content,
        checksum: environmentDigest(content),
        deviceHome: device,
        platformHome: !device,
      });
    }),
  );
}

function checkContent(content: string): void {
  if (Buffer.byteLength(content) > ENVIRONMENT_CONTENT_BYTES || content.includes("\0"))
    invalid("A fragment must be text up to 24 KiB without NUL characters.");

  if (content.includes(ENVIRONMENT_BEGIN) || content.includes(ENVIRONMENT_END))
    invalid("Canopy's managed block markers cannot be part of an instruction fragment.");
}

export function checkSelector(selector: ui.EnvironmentSelector | undefined, workers: ReadonlySet<string>): void {
  if (!selector) return;

  if (selector.workerIds.length > 200 || selector.tags.length > 32 || selector.excludeTags.length > 32)
    invalid("Too many workers or tags in an assignment.");

  for (const id of selector.workerIds) if (!workers.has(id)) throw new ConnectError("Worker not found.", Code.NotFound);

  for (const tag of [...selector.tags, ...selector.excludeTags])
    if (!/^[a-z0-9][a-z0-9._:-]{0,191}$/.test(tag)) invalid("Invalid assignment tag.");
}

/** Worker ids an assignment names that are not this computer's workers. */
export function foreignWorkers(
  selectors: readonly (ui.EnvironmentSelector | undefined)[],
  workers: readonly ui.EnvironmentWorker[],
) {
  const local = new Set(workers.map((w) => w.workerId));

  return new Set(selectors.flatMap((s) => s?.workerIds ?? []).filter((id) => uuid(id) && !local.has(id)));
}

/**
 * `foreign`: workers of linked computers that an assignment already names. Each computer applies only its own
 * workers, so their ids pass through; machine overrides name this computer's workers only.
 */
export function checkDocument(
  document: ui.InstructionDocument,
  workers: readonly ui.EnvironmentWorker[],
  foreign: ReadonlySet<string> = new Set(),
): void {
  if (document.id && !uuid(document.id)) invalid("Invalid document ID.");

  if (!document.name.trim() || document.name.length > INSTRUCTION_DOCUMENT_NAME_LENGTH)
    invalid("Name the document using up to 120 characters.");

  if (!harnesses.some((h) => h === document.harness)) invalid("Choose Claude or Codex.");

  if (!document.deviceHome && !document.platformHome) invalid("Choose a platform or device destination.");

  if (!document.selector) invalid("Choose an assignment for the document.");

  if (document.fragments.length > 64 || document.overrides.length > 200)
    invalid("Use at most 64 fragments and 200 machine overrides.");

  if (
    Buffer.byteLength(
      document.fragments.map((f) => f.content).join("") + document.overrides.map((o) => o.content).join(""),
    ) > ENVIRONMENT_CONTENT_BYTES
  )
    invalid("A document including its machine additions must fit in 24 KiB.");
  const local = new Set(workers.map((w) => w.workerId));
  const ids = new Set([...local, ...foreign]);
  checkSelector(document.selector, ids);
  const fragments = new Set<string>();

  for (const fragment of document.fragments) {
    if (!fragment.id || fragment.id.length > 100 || fragments.has(fragment.id) || fragment.name.length > 120)
      invalid("Give each fragment a unique ID and a name up to 120 characters.");
    fragments.add(fragment.id);
    checkContent(fragment.content);
    checkSelector(fragment.selector, ids);
  }

  const overrides = new Set<string>();

  for (const override of document.overrides) {
    if (!local.has(override.workerId)) throw new ConnectError("Worker not found.", Code.NotFound);

    if (overrides.has(override.workerId)) invalid("Only one override per machine is allowed.");
    overrides.add(override.workerId);
    checkContent(override.content);
  }
}
