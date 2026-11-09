import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { releaseIdentity, type ReleaseChannel } from "@canopy/domain/release/identity";
import type { MobileArtwork } from "./mobile.ts";

type Mask = "circle" | "squircle" | "rounded-square";

function maskSvg(mask: Mask) {
  const points = Array.from({ length: 721 }, (_, i) => {
    const angle = (i * Math.PI) / 360;
    const power = mask === "circle" ? 1 : 0.4;
    const axis = (value: number) => 512 + 512 * Math.sign(value) * Math.abs(value) ** power;

    return `${i ? "L" : "M"}${axis(Math.cos(angle))},${axis(Math.sin(angle))}`;
  }).join(" ");

  const shape =
    mask === "rounded-square"
      ? '<rect width="1024" height="1024" rx="205" fill="white"/>'
      : `<path d="${points}Z" fill="white"/>`;

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">${shape}</svg>`);
}

async function masked(input: Buffer, mask: Mask) {
  return sharp(input)
    .ensureAlpha()
    .composite([{ input: maskSvg(mask), blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function mockups(icons: Map<ReleaseChannel, Buffer>, directory: string) {
  const home: OverlayOptions[] = [];
  const testflight: OverlayOptions[] = [];
  let column = 0;

  for (const icon of icons.values()) {
    home.push({ input: await sharp(icon).resize(180).png().toBuffer(), left: 100 + column * 330, top: 130 });
    testflight.push({ input: await sharp(icon).resize(384).png().toBuffer(), left: 64 + column * 512, top: 40 });
    column++;
  }

  const labels = (width: number, height: number, y: number, step: number, start: number, fill: string) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="sans-serif" font-size="28" text-anchor="middle" fill="${fill}">${[...icons.keys()].map((channel, i) => `<text x="${start + i * step}" y="${y}">${releaseIdentity(channel).displayName}</text>`).join("")}</g></svg>`,
    );

  const wallpaper = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="430"><defs><linearGradient id="wall" x2="1" y2="1"><stop stop-color="#284550"/><stop offset="1" stop-color="#776076"/></linearGradient></defs><path fill="url(#wall)" d="M0 0h1170v430H0z"/><text x="60" y="65" font-family="sans-serif" font-size="32" fill="white">9:41</text></svg>`,
  );

  await sharp(wallpaper)
    .composite([...home, { input: labels(1170, 430, 360, 330, 190, "white") }])
    .png()
    .toFile(join(directory, "iphone-home-row.png"));
  await sharp({ create: { width: 1536, height: 530, channels: 3, background: "#f2f2f7" } })
    .composite([...testflight, { input: labels(1536, 530, 485, 512, 256, "#18181b") }])
    .png()
    .toFile(join(directory, "testflight-large.png"));
}

export async function writeMobilePreviews(artwork: Map<ReleaseChannel, MobileArtwork>, directory: string) {
  await mkdir(directory, { recursive: true });
  const icons = new Map<ReleaseChannel, Buffer>();

  for (const [channel, native] of artwork) {
    const ios = await masked(native.icon, "squircle");
    icons.set(channel, ios);

    for (const size of [1024, 180, 120, 87, 60])
      await sharp(ios)
        .resize(size)
        .png()
        .toFile(join(directory, `${channel}-ios-${size}.png`));

    // Launcher masks cover the central 72 dp of the adaptive 108 dp canvas.
    const adaptive = await sharp(native.background)
      .composite([{ input: native.foreground }])
      .png()
      .toBuffer();

    const viewport = await sharp(adaptive)
      .extract({ left: 171, top: 171, width: 682, height: 682 })
      .resize(1024)
      .png()
      .toBuffer();

    for (const mask of ["circle", "squircle", "rounded-square"] as const) {
      const preview = await masked(viewport, mask);
      await writeFile(join(directory, `${channel}-android-${mask}.png`), preview);
    }
  }

  await mockups(icons, directory);

  const rows = [...artwork.keys()]
    .map(
      (channel) =>
        `<section><p>${releaseIdentity(channel).displayName}</p><div class="icons"><img width="120" height="120" src="${join(directory, `${channel}-ios-120.png`)}" alt="iOS"/>${["circle", "squircle", "rounded-square"].map((mask) => `<img width="120" height="120" src="${join(directory, `${channel}-android-${mask}.png`)}" alt="Android ${mask}"/>`).join("")}</div><div class="sizes">${[180, 120, 87, 60].map((size) => `<img width="${size}" height="${size}" src="${join(directory, `${channel}-ios-${size}.png`)}" alt="iOS ${size}px"/>`).join("")}</div></section>`,
    )
    .join("");

  await writeFile(
    join(directory, "mobile-previews.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:var(--font-sans,sans-serif);color:var(--foreground)}p{margin:16px 0 8px}.icons,.sizes{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.sizes{margin:16px 0 24px}.mock{width:100%;height:auto;margin-top:16px}</style></head><body>${rows}<img class="mock" src="${join(directory, "iphone-home-row.png")}" alt="iPhone home-screen row"/><img class="mock" src="${join(directory, "testflight-large.png")}" alt="TestFlight large icons"/></body></html>`,
  );
}
