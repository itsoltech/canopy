import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { InputAttachment } from "@open-agents/contracts";
import { attachmentPath } from "@open-agents/domain";

/**
 * Attachments on the worker (docs/protocol.md, "Załączniki"): `<data_dir>/attachments/<thread_id>/<attachment_id>/<name>`.
 *
 * Outside every repository on purpose: nothing appears in `git status`, a read-only thread still gets them (the
 * worker writes them, not the harness), and Claude reads them through `additionalDirectories` without a prompt
 * (Codex's sandbox reads anywhere). The gateway names each path in the platform note; the worker writes a file only
 * at the path it computes itself for that thread and attachment (ids are UUIDs, the name a safe file name), so a
 * path from the command can never point anywhere else.
 */

export class AttachmentError extends Error {
  constructor(
    message: string,
    /** Retrying cannot help (wrong path, the gateway has no such file). */
    readonly final: boolean,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AttachmentFiles {
  /** Absolute; reported in Hello.attachments_root. */
  readonly root: string;

  constructor(dataDir: string) {
    this.root = resolve(dataDir, "attachments");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /** The thread's attachments directory (created): Claude's additionalDirectories, view_image's scope. */
  threadDir(threadId: string): string {
    if (!UUID.test(threadId)) throw new AttachmentError(`bad thread id ${threadId}`, true);
    const dir = join(this.root, threadId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * Makes sure every attachment of a turn is on disk with the right content: kept when already there (a redelivered
   * StartTurn), else fetched from the gateway, checked against its sha256 and size, and written atomically.
   */
  async ensure(threadId: string, attachments: readonly InputAttachment[], fetch: (sha256: string) => Promise<Uint8Array>): Promise<void> {
    for (const attachment of attachments) {
      if (!UUID.test(threadId) || !UUID.test(attachment.attachmentId)) throw new AttachmentError(`bad attachment id ${attachment.attachmentId}`, true);
      const path = attachmentPath(this.root, process.platform, threadId, attachment.attachmentId, attachment.name);
      if (path !== attachment.path) throw new AttachmentError(`attachment ${attachment.name}: the gateway names ${attachment.path}, this worker keeps it at ${path}`, true);
      if (matches(path, attachment)) continue;
      const data = await fetch(attachment.sha256);
      if (BigInt(data.length) !== attachment.sizeBytes || sha256(data) !== attachment.sha256) {
        throw new AttachmentError(`attachment ${attachment.name} arrived damaged (size or sha256 differ)`, false);
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.part`;
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, path);
    }
  }
}

function matches(path: string, attachment: InputAttachment): boolean {
  if (!existsSync(path)) return false;
  try {
    return BigInt(statSync(path).size) === attachment.sizeBytes && sha256(readFileSync(path)) === attachment.sha256;
  } catch {
    return false;
  }
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
