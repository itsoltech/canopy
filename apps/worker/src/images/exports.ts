import { closeSync } from "node:fs";
import type { ExportThreadImage, ThreadImageExportSchema } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { IMAGE_REPLY_LIMITS } from "@canopy/domain/image-replies";
import { imageRefusal, openImageSource, snapshotImage } from "./export-source.ts";
import { pinImageRoot, rootChanged, type ImageRoot } from "./export-root.ts";

interface ImageExport {
  threadId: string;
  turnId: string;
  path: string;
  maxBytes: bigint;
  name: string;
  sizeBytes: bigint;
  source?: ReturnType<typeof openImageSource> | undefined;
  pending?: ReturnType<typeof snapshotImage>;
  snapshot?: Awaited<ReturnType<typeof snapshotImage>>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Two bounded exports per worker, one per thread. No bytes or descriptors survive a reconnect/restart. */
export class ThreadImageExports {
  readonly #exports = new Map<string, ImageExport>();
  readonly #scopes = new Map<string, { cwd: string; attachments: string; roots: ImageRoot[] }>();
  readonly #attachmentsRoot: ImageRoot | undefined;

  constructor(attachmentsRoot?: string) {
    this.#attachmentsRoot = attachmentsRoot ? pinImageRoot(attachmentsRoot) : undefined;
  }

  /** Called before the harness starts; later turns verify the original assignment instead of trusting a new target. */
  assign(threadId: string, cwd: string, attachments: string): void {
    this.#attachmentsRoot?.verify();
    const known = this.#scopes.get(threadId);

    if (known) {
      if (known.cwd !== cwd || known.attachments !== attachments) throw rootChanged();

      for (const root of known.roots) root.verify();
    } else this.#scopes.set(threadId, { cwd, attachments, roots: [pinImageRoot(cwd), pinImageRoot(attachments)] });
  }

  async execute(
    request: ExportThreadImage,
    scope: { cwd: string; attachments: string; running: boolean },
  ): Promise<MessageInitShape<typeof ThreadImageExportSchema>> {
    const known = this.#exports.get(request.exportId);

    if (
      known &&
      (known.threadId !== request.threadId ||
        known.turnId !== request.turnId ||
        known.path !== request.path ||
        known.maxBytes !== request.maxBytes)
    )
      throw imageRefusal("This image transfer belongs to another request. Try again.");

    if (request.operation === "release") {
      this.release(request.exportId);

      return {};
    }

    if (!scope.cwd || !scope.running)
      throw imageRefusal("This turn has ended. Ask the agent to show the images again.");
    const assigned = this.#scopes.get(request.threadId);

    if (!assigned || assigned.cwd !== scope.cwd || assigned.attachments !== scope.attachments) throw rootChanged();
    const roots = assigned.roots;

    if (!request.roots.length || request.roots.some((root) => !roots.some((pin) => pin.path === root)))
      throw imageRefusal("This image is outside this thread's directory. Choose a file inside it.");

    for (const root of roots) root.verify();

    if (
      !/^[a-f0-9-]{36}$/i.test(request.exportId) ||
      request.maxBytes <= 0n ||
      request.maxBytes > BigInt(IMAGE_REPLY_LIMITS.fileBytes)
    )
      throw imageRefusal("This image exceeds the remaining image limit. Choose a smaller image.");
    let entry = known;

    if (!entry) {
      if (
        request.operation !== "probe" ||
        this.#exports.size >= 2 ||
        [...this.#exports.values()].some((e) => e.threadId === request.threadId)
      )
        throw imageRefusal("Another image is being prepared. Try again.");

      const source = openImageSource(
        request.path,
        request.roots.map((path) => roots.find((root) => root.path === path)!),
        Number(request.maxBytes),
      );

      entry = {
        threadId: request.threadId,
        turnId: request.turnId,
        path: request.path,
        maxBytes: request.maxBytes,
        name: source.name,
        sizeBytes: BigInt(source.stat.size),
        source,
        expiresAt: Date.now() + IMAGE_REPLY_LIMITS.transferMs,
        timer: setTimeout(() => this.release(request.exportId), IMAGE_REPLY_LIMITS.idleMs).unref(),
      };
      this.#exports.set(request.exportId, entry);
    }

    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => this.release(request.exportId),
      Math.max(1, Math.min(IMAGE_REPLY_LIMITS.idleMs, entry.expiresAt - Date.now())),
    ).unref();
    const metadata = { name: entry.name, sizeBytes: entry.sizeBytes };

    if (request.operation === "probe") return metadata;

    if (request.operation !== "read" || request.offset < 0n || request.offset >= entry.sizeBytes)
      throw imageRefusal("This image transfer is incomplete. Try again.");

    try {
      if (!entry.snapshot) {
        const source = entry.source;

        if (!source) throw imageRefusal("The image transfer expired. Try again.");
        const active = entry;
        entry.pending ??= snapshotImage(
          source,
          () => this.#exports.get(request.exportId) === active && Date.now() < active.expiresAt,
        );
        entry.snapshot = await entry.pending;

        if (this.#exports.get(request.exportId) !== entry) throw imageRefusal("The image transfer expired. Try again.");

        if (entry.source) {
          closeSync(entry.source.fd);
          entry.source = undefined;
        }
      }

      const offset = Number(request.offset);

      return {
        ...metadata,
        sha256: entry.snapshot.sha256,
        data: entry.snapshot.data.subarray(offset, offset + IMAGE_REPLY_LIMITS.chunkBytes),
      };
    } catch (error) {
      this.release(request.exportId);
      throw error;
    }
  }

  release(id: string): void {
    const entry = this.#exports.get(id);

    if (!entry) return;
    this.#exports.delete(id);
    clearTimeout(entry.timer);

    if (entry.source) closeSync(entry.source.fd);
  }

  close(threadId?: string): void {
    for (const [id, entry] of this.#exports) if (!threadId || entry.threadId === threadId) this.release(id);
  }
}
