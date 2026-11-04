import { inflateRawSync, crc32 } from "node:zlib";
import { isUtf8 } from "node:buffer";
import { create } from "@bufbuild/protobuf";
import { SkillFileSchema } from "@canopy/contracts";
import {
  checkSkillPath,
  SKILL_ARCHIVE_BYTES,
  SKILL_FILE_BYTES,
  SKILL_FILE_COUNT,
  SKILL_TOTAL_BYTES,
} from "@canopy/domain/skill-artifact";

/** Parse metadata before inflating. Never extract archive paths on the gateway filesystem. */
export function skillZip(bytes: Uint8Array) {
  if (bytes.length > SKILL_ARCHIVE_BYTES || bytes.length < 22) throw new Error("ZIP archives must fit in 10 MiB.");
  const zip = Buffer.from(bytes);
  let end = zip.length - 22;

  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;

  if (end < 0 || end < zip.length - 65557 || end + 22 + zip.readUInt16LE(end + 20) !== zip.length)
    throw new Error("Invalid ZIP directory.");
  const count = zip.readUInt16LE(end + 10);
  const directory = zip.readUInt32LE(end + 16);

  if (
    zip.readUInt32LE(end + 4) !== 0 ||
    count !== zip.readUInt16LE(end + 8) ||
    count > SKILL_FILE_COUNT + 100 ||
    directory + zip.readUInt32LE(end + 12) !== end
  )
    throw new Error("Split, ZIP64 or oversized archives are not supported.");
  let cursor = directory;
  let total = 0;
  const files = [];

  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP entry.");
    const compressed = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);

    if (next > end) throw new Error("Invalid ZIP entry length.");
    const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength);

    if (!isUtf8(nameBytes)) throw new Error("ZIP paths must be UTF-8.");
    const name = nameBytes.toString("utf8");
    const mode = zip.readUInt32LE(cursor + 38) >>> 16;
    const kind = mode & 0o170000;
    const directoryEntry = name.endsWith("/");
    checkSkillPath(directoryEntry ? name.slice(0, -1) : name);

    if (kind && kind !== (directoryEntry ? 0o040000 : 0o100000))
      throw new Error("Symlinks, devices and special ZIP entries are not allowed.");
    total += size;

    if (size > SKILL_FILE_BYTES || total > SKILL_TOTAL_BYTES)
      throw new Error("ZIP expands beyond the skill size limits.");
    const method = zip.readUInt16LE(cursor + 10);
    const flags = zip.readUInt16LE(cursor + 8);
    const local = zip.readUInt32LE(cursor + 42);

    if (flags & 1 || ![0, 8].includes(method) || local + 30 > directory || zip.readUInt32LE(local) !== 0x04034b50)
      throw new Error("Encrypted or unsupported ZIP entry.");
    const localName = zip.readUInt16LE(local + 26);
    const start = local + 30 + localName + zip.readUInt16LE(local + 28);

    if (
      start + compressed > directory ||
      !zip.subarray(local + 30, local + 30 + localName).equals(nameBytes) ||
      zip.readUInt16LE(local + 8) !== method ||
      zip.readUInt16LE(local + 6) !== flags
    )
      throw new Error("Inconsistent ZIP headers.");

    if (!directoryEntry) {
      const packed = zip.subarray(start, start + compressed);
      const content = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: SKILL_FILE_BYTES + 1 });

      if (content.length !== size || crc32(content) !== zip.readUInt32LE(cursor + 16))
        throw new Error("Invalid ZIP content checksum.");
      files.push(create(SkillFileSchema, { path: name, content, executable: Boolean(mode & 0o111) }));
    }

    cursor = next;
  }

  if (cursor !== end) throw new Error("Invalid ZIP directory size.");

  // Accept a single enclosing folder, as produced by common desktop ZIP tools.
  if (!files.some((file) => file.path === "SKILL.md")) {
    const root = files[0]?.path.split("/")[0];

    if (root && files.every((file) => file.path.startsWith(`${root}/`)))
      for (const file of files) file.path = file.path.slice(root.length + 1);
  }

  return files;
}
