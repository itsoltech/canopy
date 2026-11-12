import { createHash } from "node:crypto";
import type { BotFileOperation } from "@canopy/contracts";
import type { CommandOutput } from "../runtime/host-types.ts";
import { downloadBotFile, type BotDownloadOptions } from "./download.ts";
import { BotFileError, type BotWorkspace } from "./workspace.ts";

interface FileExport {
  id: string;
  data: Buffer;
  name: string;
  sha256: string;
  created: number;
}

/** One bounded immutable export per active conversation; binary bytes never become model tool results. */
export class BotFileOperations {
  readonly #exports = new Map<string, FileExport>();
  constructor(readonly downloads: BotDownloadOptions = {}) {}
  drop(botId: string): void {
    this.#exports.delete(botId);
  }
  async execute(workspace: BotWorkspace, input: BotFileOperation, signal: AbortSignal): Promise<CommandOutput> {
    let result;

    switch (input.operation) {
      case "list":
        result = workspace.list();
        break;
      case "read":
        result = {
          name: input.path,
          text: new TextDecoder("utf-8", { fatal: true }).decode(await workspace.read(input.path, 100_000)),
        };
        break;
      case "write":
        result = workspace.write(input.path, Buffer.from(input.text));
        break;
      case "delete":
        result = workspace.delete(input.path);
        break;
      case "download":
        result = await downloadBotFile(workspace, input.url, input.filename, signal, this.downloads);
        break;
      case "export":
        return this.export(workspace, input);
      case "release":
        this.drop(input.botId);
        result = { released: true };
        break;
      default:
        throw new BotFileError("Unknown file operation.");
    }

    signal.throwIfAborted();

    return { botFile: { resultJson: JSON.stringify(result) } };
  }
  async export(workspace: BotWorkspace, input: BotFileOperation): Promise<CommandOutput> {
    if (!/^[a-f0-9-]{36}$/i.test(input.exportId)) throw new BotFileError("Invalid file transfer.");
    let saved = this.#exports.get(input.botId);

    if (!saved || saved.id !== input.exportId || Date.now() - saved.created > 60_000) {
      if (input.offset !== 0n) throw new BotFileError("The file transfer expired. Try again.");
      const data = await workspace.read(input.path);
      saved = {
        id: input.exportId,
        data,
        name: input.path,
        sha256: createHash("sha256").update(data).digest("hex"),
        created: Date.now(),
      };
      this.#exports.set(input.botId, saved);
    }

    const offset = Number(input.offset);

    if (!Number.isSafeInteger(offset) || offset < 0 || offset > saved.data.length || saved.name !== input.path)
      throw new BotFileError("Invalid file transfer offset.");

    return {
      botFile: {
        name: saved.name,
        sha256: saved.sha256,
        sizeBytes: BigInt(saved.data.length),
        data: saved.data.subarray(offset, offset + 1024 ** 2),
      },
    };
  }
}
