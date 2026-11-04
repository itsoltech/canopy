const { execFileSync, spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { machOFiles, machOArchitectures } = require("./macho.cjs");

if (process.platform !== "darwin") throw new Error("Verify macOS signatures on a macOS runner");

const directory = process.argv[2];

if (!directory) throw new Error("Usage: node scripts/verify-macos.cjs <release/channel>");

const applications = [];

for (const entry of readdirSync(directory, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("mac")) continue;

  for (const name of readdirSync(join(directory, entry.name))) {
    if (name.endsWith(".app")) applications.push(join(directory, entry.name, name));
  }
}

if (!applications.length) throw new Error("No packaged macOS applications found");

function verifyJit(path) {
  const result = spawnSync("codesign", ["--display", "--verbose=4", "--entitlements", ":-", path], {
    encoding: "utf8",
  });

  if (result.error) throw result.error;
  const details = result.stdout + result.stderr;

  if (result.status !== 0 || !/flags=.*\bruntime\b/.test(details)) throw new Error(`Hardened runtime missing: ${path}`);

  for (const key of ["allow-jit", "allow-unsigned-executable-memory", "disable-library-validation"]) {
    if (!new RegExp(`<key>com\\.apple\\.security\\.cs\\.${key}</key>\\s*<true\\s*/>`).test(details))
      throw new Error(`Missing ${key} entitlement: ${path}`);
  }
}

for (const application of applications) {
  for (const binary of machOFiles(application))
    if (machOArchitectures(binary).join() !== "arm64")
      throw new Error(`macOS app contains a non-arm64 Mach-O: ${binary}`);
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application], { stdio: "inherit" });
  verifyJit(application);
  const binaries = machOFiles(join(application, "Contents/Resources/runtime"));

  if (!binaries.length) throw new Error("No Mach-O runtime binaries found");

  for (const binary of binaries) execFileSync("codesign", ["--verify", "--strict", binary], { stdio: "inherit" });
  verifyJit(join(application, "Contents/Resources/runtime/bun"));

  if (process.env.CANOPY_MAC_SIGNED === "true") {
    execFileSync(
      "codesign",
      [
        "--verify",
        "--strict",
        "--test-requirement==anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
        application,
      ],
      { stdio: "inherit" },
    );
    const assessment = spawnSync("spctl", ["-a", "-vv", "--type", "execute", application], { stdio: "inherit" });

    if (assessment.error) throw assessment.error;

    if (process.env.CANOPY_MAC_NOTARIZED === "true") {
      if (assessment.status !== 0) throw new Error("Gatekeeper rejected the notarized application");
      execFileSync("xcrun", ["stapler", "validate", application], { stdio: "inherit" });
    } else if (assessment.status !== 0)
      console.info("Developer ID signature verified; Gatekeeper may reject a build without notarization");
  }

  console.info(`Verified ${binaries.length} runtime signatures in ${application}`);
}
