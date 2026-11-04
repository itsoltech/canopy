import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { desktopIdentity } from "../src/identity.ts";

const desktop = resolve(import.meta.dir, "..");
const { channel } = desktopIdentity();
const source = resolve(desktop, "../web/static/icon-512.png");
const destination = resolve(desktop, "build", channel, "icon.png");

mkdirSync(resolve(desktop, "build", channel), { recursive: true });

if (channel === "stable") copyFileSync(source, destination);
else {
  // Preserve the source alpha and silhouette, tinting the existing artwork.
  await sharp(source)
    .grayscale()
    .tint(channel === "beta" ? "#f59e0b" : "#8b5cf6")
    .png()
    .toFile(destination);
}
