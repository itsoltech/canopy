import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { desktopIdentity } from "../src/identity.ts";

const desktop = resolve(import.meta.dir, "..");
const { channel } = desktopIdentity();
const source = resolve(desktop, `../web/static/channels/${channel}/icon-512.png`);
const destination = resolve(desktop, "build", channel, "icon.png");

mkdirSync(resolve(desktop, "build", channel), { recursive: true });

copyFileSync(source, destination);
