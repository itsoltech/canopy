import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Schema } from "effect";
import { fontFamilies } from "@canopy/ui/fonts";

const execute = promisify(execFile);

/** Fixed commands only. No renderer input reaches an executable, argument or shell. */
export async function systemFonts(platform = process.platform): Promise<string[]> {
  const options = { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "utf8" as const };

  if (platform === "linux") {
    const { stdout } = await execute("fc-list", ["--format", "%{family[0]}\n"], options);

    return fontFamilies(stdout.split("\n"));
  }

  if (platform === "darwin") {
    const { stdout } = await execute(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        'ObjC.import("AppKit"); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies))',
      ],
      options,
    );

    return fontFamilies(Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(stdout)));
  }

  if (platform === "win32") {
    const { stdout } = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }",
      ],
      options,
    );

    return fontFamilies(stdout.split(/\r?\n/));
  }

  throw new Error("Installed fonts are unavailable on this platform");
}
