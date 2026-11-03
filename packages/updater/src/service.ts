/** Print-only: no service installation and no credentials in generated unit/plist content. */
export function serviceSnippet(app: "worker" | "gateway", platform: string, executable: string, args: string[]): string {
  const name = `canopy-${app}`;
  if (platform === "darwin") {
    const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    return `Save as ~/Library/LaunchAgents/com.canopy.${app}.plist, then run:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.canopy.${app}.plist

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.canopy.${app}</string>
  <key>ProgramArguments</key><array>${[executable, ...args].map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin")}</string></dict>
</dict></plist>`;
  }
  const unit = (s: string) => '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$") + '"';
  return `Save as ~/.config/systemd/user/${name}.service, then run:
systemctl --user daemon-reload
systemctl --user enable --now ${name}

[Unit]
Description=Canopy ${app}
After=network-online.target

[Service]
ExecStart=${[executable, ...args].map(unit).join(" ")}
${app === "gateway" ? "EnvironmentFile=%h/.config/canopy/gateway.env\n" : ""}Environment=${unit(`PATH=${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}`)}
Restart=always
RestartPreventExitStatus=78
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target`;
}
