import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { desktopIdentity } from "../src/identity.ts";

const desktop = resolve(import.meta.dir, "..");
const identity = desktopIdentity();
const stamp = resolve(desktop, "dist/identity.json");

if (
  !existsSync(stamp) ||
  JSON.parse(readFileSync(stamp, "utf8")).channel !== identity.channel ||
  !existsSync(resolve(desktop, `build/${identity.channel}/icon.png`))
) {
  await import("./prepare-identity.ts");
  await import("./build-shell.ts");
}

if (!["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64"].includes(`${process.platform}-${process.arch}`))
  throw new Error("Unsupported packaging host");

const platform = process.platform === "linux" ? "--linux" : process.platform === "darwin" ? "--mac" : "--win";
const extra = process.argv.slice(2);

const args = extra.includes("--dir")
  ? [platform]
  : process.platform === "linux"
    ? [platform, "AppImage", "deb"]
    : process.platform === "darwin"
      ? [platform, "dmg", "zip"]
      : [platform, "nsis"];

const os = process.platform === "win32" ? "windows" : process.platform;
const base = JSON.parse(readFileSync(resolve(desktop, "package.json"), "utf8")).build;
const icon = `build/${identity.channel}/icon.png`;
const signed = Boolean(process.env["CSC_LINK"]);

const windowsSigned = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"].every((name) =>
  Boolean(process.env[name]),
);

const { azureSignOptions, ...windows } = base.win;

const notarize =
  signed &&
  Boolean(
    (process.env["APPLE_API_KEY"] && process.env["APPLE_API_KEY_ID"] && process.env["APPLE_API_ISSUER"]) ||
    (process.env["APPLE_ID"] && process.env["APPLE_APP_SPECIFIC_PASSWORD"] && process.env["APPLE_TEAM_ID"]),
  );

const configuration = {
  ...base,
  appId: identity.appId,
  productName: identity.productName,
  executableName: identity.executableName,
  artifactName: `${identity.artifactPrefix}-\${version}-${os}-${process.arch}.\${ext}`,
  directories: { ...base.directories, output: `release/${identity.channel}` },
  extraMetadata: {
    name: identity.executableName,
    desktopName: `${identity.executableName}.desktop`,
    canopyChannel: identity.channel,
  },
  extraResources: [
    ...base.extraResources.filter((resource: { to: string }) => resource.to !== "icon.png"),
    { from: icon, to: "icon.png" },
  ],
  protocols: [{ name: `${identity.productName} enrollment`, schemes: [identity.scheme] }],
  linux: { ...base.linux, icon, desktop: { entry: { StartupWMClass: identity.productName } } },
  mac: { ...base.mac, icon, ...(!signed && { identity: "-" }), notarize },
  // Omit Azure configuration completely for unsigned builds; its presence selects the signing provider.
  win: { ...windows, icon, signExecutable: windowsSigned, ...(windowsSigned && { azureSignOptions }) },
  // Never advertise an ad-hoc macOS build to already signed clients.
  publish:
    process.platform === "darwin" && !signed
      ? null
      : [
          {
            provider: "github",
            owner: "itsoltech",
            repo: "canopy",
            channel: identity.feed,
            releaseType: identity.channel === "stable" ? "release" : "prerelease",
          },
        ],
  detectUpdateChannel: false,
  generateUpdatesFilesForAllChannels: false,
  forceCodeSigning: (process.platform === "darwin" && signed) || (process.platform === "win32" && windowsSigned),
};

const version = process.env["CANOPY_VERSION"];

if (version) Object.assign(configuration.extraMetadata, { version });

const configPath = resolve(desktop, "build", `builder-${identity.channel}.json`);

writeFileSync(configPath, JSON.stringify(configuration, null, 2));

const builder = resolve(require.resolve("electron-builder"), "../cli/cli.js");
const environment = { ...process.env };

if (environment["APPLE_API_KEY"] && environment["APPLE_API_KEY_ID"] && environment["APPLE_API_ISSUER"]) {
  delete environment["APPLE_ID"];
  delete environment["APPLE_APP_SPECIFIC_PASSWORD"];
  delete environment["APPLE_TEAM_ID"];
}

const child = Bun.spawn(
  ["node", builder, ...args, `--${process.arch}`, "--config", configPath, ...extra, "--publish", "never"],
  { cwd: desktop, env: environment, stdio: ["inherit", "inherit", "inherit"] },
);

process.exit(await child.exited);
