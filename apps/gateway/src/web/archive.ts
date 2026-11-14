import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { isJsonArray, isJsonObject, isNumber, isString, parseJson } from "@canopy/domain/json";

/**
 * The web build (`scripts/build-web.ts` output) packed into one embedded file of the gateway binary
 * (docs/deploy.md, "Binaria (systemd)"): zstd over `CNPYWEB1`, a u32 header length, the JSON header
 * `{ version, files: [[path, size], …] }` and the file contents in header order.
 */
const MAGIC = new TextEncoder().encode("CNPYWEB1");

export interface WebArchiveHeader {
  version: string;
  files: (readonly [path: string, size: number])[];
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .split(sep)
        .join("/"),
    )
    .sort();
}

/** Packs a web build directory; build-time only (scripts/build-binaries.ts). */
export async function packWeb(directory: string, version: string): Promise<Uint8Array> {
  const paths = await filesBelow(directory);
  const contents = await Promise.all(paths.map((path) => readFile(join(directory, path))));
  const header: WebArchiveHeader = { version, files: paths.map((path, i) => [path, contents[i]!.length] as const) };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.length, true);

  return Bun.zstdCompressSync(Buffer.concat([MAGIC, length, json, ...contents]), { level: 19 });
}

function safePath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((p) => p === ".." || p === "." || p === "")
  );
}

function decodeHeader(text: string): WebArchiveHeader {
  const value = parseJson(text);

  if (!isJsonObject(value) || !isString(value["version"]) || !isJsonArray(value["files"]))
    throw new Error("Embedded web archive has an invalid header");

  const files = value["files"].map((entry) => {
    if (!isJsonArray(entry) || !isString(entry[0]) || !isNumber(entry[1]) || !safePath(entry[0]))
      throw new Error("Embedded web archive has an invalid file entry");

    return [entry[0], entry[1]] as const;
  });

  return { version: value["version"], files };
}

/** Unpacks into an empty directory and returns the archive's header. */
export async function unpackWeb(archive: Uint8Array, directory: string): Promise<WebArchiveHeader> {
  const bytes = Bun.zstdDecompressSync(archive);

  if (!MAGIC.every((byte, i) => bytes[i] === byte)) throw new Error("Embedded web archive has an unknown format");
  const length = new DataView(bytes.buffer, bytes.byteOffset + MAGIC.length, 4).getUint32(0, true);
  let offset = MAGIC.length + 4;
  const header = decodeHeader(new TextDecoder().decode(bytes.subarray(offset, offset + length)));
  offset += length;
  const directories = new Set(header.files.map(([path]) => dirname(join(directory, path))));

  for (const path of directories) await mkdir(path, { recursive: true, mode: 0o755 });

  for (const [path, size] of header.files) {
    if (offset + size > bytes.length) throw new Error("Embedded web archive is truncated");
    await writeFile(join(directory, path), bytes.subarray(offset, offset + size), { mode: 0o644 });
    offset += size;
  }

  if (offset !== bytes.length) throw new Error("Embedded web archive has trailing data");

  return header;
}

/** The build's version file (`canopy-web.json`, written by scripts/build-web.ts). */
export async function webBuildVersion(directory: string): Promise<string> {
  const value = parseJson(await readFile(join(directory, "canopy-web.json"), "utf8"));

  if (!isJsonObject(value) || !isString(value["version"]) || !(await stat(join(directory, "index.js"))).isFile())
    throw new Error(`${directory} is not a Canopy web build (bun scripts/build-web.ts)`);

  return value["version"];
}
