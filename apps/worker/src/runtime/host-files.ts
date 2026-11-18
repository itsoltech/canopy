import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { isWithin } from "../git/worktrees.ts";
import type { InputAttachment } from "@canopy/contracts";
import { AttachmentError } from "../attachments/files.ts";
import { ImageError, viewImage, type ViewImageResult } from "../images/index.ts";

import { CommandError } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import { resolveDirectoryPath } from "./directory-path.ts";

const FETCH_TIMEOUT_MS = 120_000;

export class HostFiles {
  constructor(readonly ctx: HostContext) {}
  checkCwd(cwd: string): void {
    if (!isAbsolute(cwd)) throw new CommandError("CWD_NOT_ABSOLUTE", `${cwd} must be an absolute directory path`, true);
    let real: string;

    try {
      real = realpathSync(cwd);
    } catch {
      throw new CommandError("CWD_NOT_FOUND", `${cwd} does not exist`, true);
    }

    if (!statSync(real).isDirectory()) throw new CommandError("CWD_NOT_DIRECTORY", `${cwd} is not a directory`, true);

    if ([...this.ctx.state.removingPaths].some((path) => isWithin(path, real)))
      throw new CommandError("WORKTREE_BUSY", "worktree cleanup is in progress", false);

    if ([...this.ctx.state.switchingPaths].some((path) => isWithin(path, real)))
      throw new CommandError("CHECKOUT_BUSY", "A Git operation is in progress. Wait for it to finish.", false);
  }

  listDirectory(path: string) {
    const config = this.ctx.state.config;

    if (!config) throw new CommandError("WORKER_NOT_CONFIGURED", "the worker has no configuration yet", false);

    const entry = (dir: string, name: string) => {
      const full = join(dir, name);
      let isDir = false;

      try {
        isDir = statSync(full).isDirectory();
      } catch {
        // broken symlink or no permission: listed as a file
      }

      return { name, isDir, isGitRepo: isDir && existsSync(join(full, ".git")) };
    };

    path ||= homedir();
    const directoryPath = resolveDirectoryPath(path);
    this.ctx.ops.checkCwd(directoryPath);

    const entries = readdirSync(directoryPath)
      .sort()
      .slice(0, 1000)
      .map((name) => entry(directoryPath, name));

    return { entries, directoryPath };
  }

  async ensureAttachments(
    threadId: string,
    attachments: readonly InputAttachment[],
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.ctx.state.files.ensure(threadId, attachments, async (sha256) => {
        const data = await this.ctx.ops.fetchBlob(threadId, sha256, "", signal);
        signal?.throwIfAborted();

        return data;
      });
    } catch (error) {
      if (error instanceof AttachmentError)
        throw new CommandError("ATTACHMENT_UNAVAILABLE", error.message, error.final);
      throw new CommandError(
        "ATTACHMENT_UNAVAILABLE",
        `attachments could not be written: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
  }

  fetchBlob(threadId: string, sha256: string, botTurnId = "", signal?: AbortSignal): Promise<Uint8Array> {
    const link = this.ctx.state.link;

    if (!link) return Promise.reject(new AttachmentError("not connected to the gateway", false));
    const requestId = Bun.randomUUIDv7();

    return new Promise<Uint8Array>((resolve, reject) => {
      const cleanup = () => {
        this.ctx.state.fetches.delete(requestId);
        signal?.removeEventListener("abort", abort);
        clearTimeout(timer);
      };

      const abort = () => {
        cleanup();
        reject(new AttachmentError("attachment fetch was interrupted", false));
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new AttachmentError("the gateway did not hand over the attachment in time", false));
      }, FETCH_TIMEOUT_MS);

      if (signal?.aborted) {
        abort();

        return;
      }

      signal?.addEventListener("abort", abort, { once: true });
      this.ctx.state.fetches.set(requestId, {
        chunks: [],
        resolve: (data) => (cleanup(), resolve(data)),
        reject: (error) => (cleanup(), reject(error)),
      });

      try {
        link.send({
          case: "fetchBlob",
          value: {
            requestId,
            threadId: botTurnId ? "" : threadId,
            sha256,
            botId: botTurnId ? threadId : "",
            botTurnId,
          },
        });
      } catch {
        cleanup();
        reject(new AttachmentError("the gateway link closed", false));
      }
    });
  }

  /** view_image: an image from the thread's working directory or attachments, scaled for any model. */
  async viewImage(threadId: string, cwd: string, path: string): Promise<ViewImageResult> {
    try {
      if (!cwd)
        return { ok: false, message: "view_image: the thread's working directory is not known on this worker yet" };
      const image = await viewImage(path, { cwd, roots: [cwd, this.ctx.state.files.threadDir(threadId)] });
      const scaled = image.width !== image.originalWidth || image.height !== image.originalHeight;

      return {
        ok: true,
        base64: Buffer.from(image.data).toString("base64"),
        mimeType: image.mimeType,
        summary: `${image.path}: ${image.originalWidth}×${image.originalHeight} px${scaled ? `, shown at ${image.width}×${image.height}` : ""} (${image.mimeType}).`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `view_image: ${error instanceof ImageError ? error.message : `the image could not be read (${error instanceof Error ? error.message : String(error)})`}`,
      };
    }
  }
}
