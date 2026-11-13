/** Container recognition and duration only. No codecs execute and no filename is trusted. */
const videoBrands = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "qt  "]);

function word(data: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

export function videoType(data: Uint8Array): string | undefined {
  if (data.length >= 16 && word(data, 4, 4) === "ftyp") {
    const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
    const brand = word(data, 8, 4);

    if (size >= 16 && size <= data.length && videoBrands.has(brand))
      return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }

  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    // DocType must be an actual EBML header element, not an arbitrary string elsewhere in the file.
    const header = ebmlElements(data, 0, Math.min(data.length, 4096)).find((element) => element.id === 0x1a45dfa3);

    if (
      header &&
      ebmlElements(data, header.start, header.end).some(
        (element) => element.id === 0x4282 && word(data, element.start, element.end - element.start) === "webm",
      )
    )
      return "video/webm";
  }

  return undefined;
}

function duration(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 && value <= 0xffff_ffff ? Math.round(value) : undefined;
}

/** MP4/MOV movie header or WebM Segment Info; traversal and reads are bounded by the uploaded bytes. */
export function videoDurationMs(data: Uint8Array, mimeType: string): number | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (mimeType !== "video/webm") {
    const movie = boxes(data, 0, data.length).find((box) => box.type === "moov");
    const header = movie && boxes(data, movie.start, movie.end).find((box) => box.type === "mvhd");

    if (!header) return undefined;
    const version = data[header.start];
    const offset = header.start + (version === 1 ? 20 : 12);

    if ((version !== 0 && version !== 1) || offset + (version === 1 ? 12 : 8) > header.end) return undefined;
    const scale = view.getUint32(offset);
    const ticks = version === 1 ? Number(view.getBigUint64(offset + 4)) : view.getUint32(offset + 4);

    return scale ? duration((ticks * 1000) / scale) : undefined;
  }

  const segment = ebmlElements(data, 0, data.length).find((element) => element.id === 0x18538067);
  const info = segment && ebmlElements(data, segment.start, segment.end).find((element) => element.id === 0x1549a966);

  if (!info) return undefined;
  let scale = 1_000_000;
  let ticks = 0;

  for (const element of ebmlElements(data, info.start, info.end)) {
    const size = element.end - element.start;

    if (element.id === 0x2ad7b1 && size <= 4)
      scale = data.subarray(element.start, element.end).reduce((value, byte) => value * 256 + byte, 0);

    if (element.id === 0x4489 && (size === 4 || size === 8))
      ticks = size === 4 ? view.getFloat32(element.start) : view.getFloat64(element.start);
  }

  return duration((ticks * scale) / 1_000_000);
}

function boxes(data: Uint8Array, start: number, end: number) {
  const result: { type: string; start: number; end: number }[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  for (let offset = start; offset + 8 <= end && result.length < 4096;) {
    let size = view.getUint32(offset);
    let header = 8;

    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    }

    if (size === 0) size = end - offset;

    if (!Number.isSafeInteger(size) || size < header || offset + size > end) break;
    result.push({ type: word(data, offset + 4, 4), start: offset + header, end: offset + size });
    offset += size;
  }

  return result;
}

function vint(data: Uint8Array, offset: number, id: boolean) {
  const first = data[offset] ?? 0;
  let mask = 0x80;
  let length = 1;

  while (mask && !(first & mask)) {
    mask >>= 1;
    length++;
  }

  if (!mask || length > (id ? 4 : 8) || offset + length > data.length) return undefined;
  let value = id ? first : first & (mask - 1);
  let unknown = !id && value === mask - 1;

  for (let i = 1; i < length; i++) {
    const byte = data[offset + i]!;
    value = value * 256 + byte;
    unknown &&= byte === 255;
  }

  return { value, length, unknown };
}

function ebmlElements(data: Uint8Array, start: number, end: number) {
  const result: { id: number; start: number; end: number }[] = [];

  for (let offset = start; offset < end && result.length < 4096;) {
    const id = vint(data, offset, true);
    const size = id && vint(data, offset + id.length, false);

    if (!id || !size) break;
    const body = offset + id.length + size.length;
    const next = size.unknown ? end : body + size.value;

    if (!Number.isSafeInteger(next) || next > end || next <= offset) break;
    result.push({ id: id.value, start: body, end: next });
    offset = next;
  }

  return result;
}

export function formatVideoDuration(milliseconds: number | undefined) {
  if (!milliseconds || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  const seconds = Math.ceil(milliseconds / 1000);

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
