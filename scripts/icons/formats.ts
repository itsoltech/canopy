import sharp from "sharp";

/** ICO directory with PNG payloads (Vista and later), including a 256 px shell icon. */
export async function ico(source: Buffer) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map((size) => sharp(source).resize(size).png().toBuffer()));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;

  for (const [i, size] of sizes.entries()) {
    const entry = 6 + i * 16;
    const png = images[i]!;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  }

  return Buffer.concat([header, ...images]);
}

function icnsChunk(type: string, payload: Uint8Array) {
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(payload.length + header.length, 4);

  return Buffer.concat([header, payload]);
}

function icnsColorPlane(pixels: Uint8Array) {
  // ICNS RLE accepts literal packets of up to 128 pixels, with a length-minus-one prefix.
  const plane = Buffer.alloc(pixels.length + Math.ceil(pixels.length / 128));

  for (let offset = 0, packet = 0; offset < pixels.length; offset += 128, packet++) {
    const length = Math.min(128, pixels.length - offset);
    plane[offset + packet] = length - 1;
    plane.set(pixels.subarray(offset, offset + length), offset + packet + 1);
  }

  return plane;
}

async function smallIcnsImage(source: Buffer, size: number, rgbType: string, maskType: string) {
  const pixels = await sharp(source).resize(size).ensureAlpha().raw().toBuffer();
  const colorPlanes = [0, 1, 2].map((channel) => icnsColorPlane(pixels.filter((_, index) => index % 4 === channel)));
  const alpha = pixels.filter((_, index) => index % 4 === 3);

  return [icnsChunk(rgbType, Buffer.concat(colorPlanes)), icnsChunk(maskType, alpha)];
}

export async function icns(source: Buffer) {
  // macOS can scramble PNG entries icp4/icp5/icp6 when reading an app bundle's icon.
  const chunks = [
    ...(await smallIcnsImage(source, 16, "is32", "s8mk")),
    ...(await smallIcnsImage(source, 32, "il32", "l8mk")),
  ];

  const pngEntries = [
    ["ic11", 32], // 16 pt @2x
    ["ic12", 64], // 32 pt @2x
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ] as const;

  const pngChunks = await Promise.all(
    pngEntries.map(async ([type, size]) => icnsChunk(type, await sharp(source).resize(size).png().toBuffer())),
  );

  return icnsChunk("icns", Buffer.concat([...chunks, ...pngChunks]));
}
