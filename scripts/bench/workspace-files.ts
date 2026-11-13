import { createHash } from "node:crypto";
import { FileResolution, type Command, FileContentSchema, type ThreadFilesUpdate } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { CommandResultSchema } from "@canopy/contracts";
import { workspaceDirectory } from "./workspace-directory.ts";

const names = [
  "sample.ts",
  "a.ts",
  "a-very-long-file-name-for-checking-workspace-tab-overflow-and-path-disambiguation.ts",
  "hundred-kib.ts",
  ...Array.from({ length: 12 }, (_, index) => `tab-${index + 1}.ts`),
];

export const workspaceFileLinks = names.map((name) => `\`${name}:31-40\``).join(" · ");

/** Disposable synthetic files; uses real filesystem enumeration and invalidation, without any provider CLI. */
export function workspaceFiles() {
  const files = new Map<string, Uint8Array>(
    names.map((name) => [
      name,
      new TextEncoder().encode(
        Array.from(
          { length: name === "hundred-kib.ts" ? 2100 : 180 },
          (_, index) => `export const value${index + 1} = "Synthetic workspace line ${index + 1}";`,
        )
          .join("\n")
          .slice(0, name === "hundred-kib.ts" ? 100 * 1024 : undefined),
      ),
    ]),
  );

  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const directory = workspaceDirectory(files);

  const execute = async (
    command: Command,
    send: (update: ThreadFilesUpdate) => void,
  ): Promise<MessageInitShape<typeof CommandResultSchema> | undefined> => {
    const kind = command.kind;

    if (kind.case === "listThreadDirectory")
      return { commandId: command.commandId, ok: true, threadDirectory: await directory.list(kind.value) };

    if (kind.case === "watchThreadFiles") {
      await directory.watch(kind.value, send);

      return { commandId: command.commandId, ok: true };
    }

    if (kind.case !== "readFile" && kind.case !== "writeFile" && kind.case !== "deleteFile") return undefined;
    const target = kind.case === "writeFile" ? kind.value.target : kind.value;
    const path = target?.path ?? "";
    const relative = path.replace(/^\/srv\/canopy\//, "");
    const content = files.has(relative) ? directory.read(relative) : undefined;
    const base = { commandId: command.commandId, ok: true };

    if (!content) return { ...base, file: { path, relativePath: relative, resolution: FileResolution.NOT_FOUND } };
    const sha256 = hash(content);

    if (kind.case !== "readFile" && target?.expectedSha256 !== sha256)
      return {
        ...base,
        ok: false,
        errorCode: "FILE_CHANGED",
        errorMessage: "The file changed on disk. Reload before saving.",
      };

    if (kind.case === "deleteFile") {
      files.delete(relative);
      directory.remove(relative);

      return base;
    }

    const bytes = kind.case === "writeFile" ? kind.value.content : content;

    if (kind.case === "writeFile") {
      files.set(relative, bytes);
      directory.write(relative, bytes);
    }

    const file: MessageInitShape<typeof FileContentSchema> = {
      path: `/srv/canopy/${relative}`,
      relativePath: relative,
      content: bytes,
      size: BigInt(bytes.length),
      sha256: hash(bytes),
      mimeType: "text/plain",
      resolution: FileResolution.FOUND,
    };

    return { ...base, file };
  };

  return Object.assign(execute, { close: () => directory.close() });
}
