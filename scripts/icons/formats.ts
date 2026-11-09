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

/** Modern ICNS PNG representations; 32/64 entries supply the small Retina icons. */
export async function icns(source: Buffer) {
  const entries = [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ] as const;

  const chunks = await Promise.all(
    entries.map(async ([type, size]) => {
      const png = await sharp(source).resize(size).png().toBuffer();
      const header = Buffer.alloc(8);
      header.write(type);
      header.writeUInt32BE(png.length + 8, 4);

      return Buffer.concat([header, png]);
    }),
  );

  const header = Buffer.alloc(8);
  header.write("icns");
  header.writeUInt32BE(8 + chunks.reduce((length, chunk) => length + chunk.length, 0), 4);

  return Buffer.concat([header, ...chunks]);
}
