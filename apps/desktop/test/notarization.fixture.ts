import { mock, spyOn } from "bun:test";

// Isolated subprocess: exercise electron-builder's real notarize dependency and
// promise-retry without Apple credentials, platform tools, or real backoff waits.
const scenario = process.argv[2];
const commands: string[] = [];
const delays: number[] = [];
let staples = 0;
let validations = 0;

mock.module(require.resolve("@electron/notarize/lib/spawn.js"), () => ({
  spawn: async (command: string, args: string[]) => {
    const operation = command === "xcrun" ? args.slice(0, 2).join(" ") : command;
    commands.push(operation);

    if (operation === "notarytool submit")
      return { code: 0, output: JSON.stringify({ status: scenario === "rejected" ? "Rejected" : "Accepted" }) };

    if (operation === "stapler staple") {
      staples++;

      if (scenario === "exhausted" || (scenario === "transient" && staples === 1))
        return { code: 68, output: "NSURLErrorDomain Code=-1005: The network connection was lost" };
    }

    if (operation === "stapler validate") {
      validations++;

      if (scenario === "validation" && validations === 1) return { code: 65, output: "Ticket unavailable" };
    }

    return { code: 0, output: "" };
  },
}));

const realTimeout = globalThis.setTimeout;

const immediateTimeout = (callback: () => void, delay?: number) => {
  delays.push(delay ?? 0);

  return realTimeout(callback, 0);
};

// SAFETY: In this isolated fixture promise-retry only schedules zero-argument
// callbacks; it never uses DOM string handlers or Node's __promisify__ overload.
spyOn(globalThis, "setTimeout").mockImplementation(immediateTimeout as typeof setTimeout);

const { notarize } = await import("@electron/notarize");
let error = "";

try {
  // A dmg avoids unrelated app signature commands; notarytool and stapling use
  // the same implementation as the .app submitted by electron-builder.
  await notarize({
    appPath: "/fixture/Canopy.dmg",
    appleApiKey: "fixture",
    appleApiKeyId: "fixture",
    appleApiIssuer: "fixture",
  });
} catch (cause) {
  error = cause instanceof Error ? cause.message : "Unexpected notarization failure";
}

console.log(JSON.stringify({ error, commands, delays }));
