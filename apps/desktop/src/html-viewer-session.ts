import { session } from "electron";

/** Same deny-all session for visible and offscreen viewers in their separate browser process. */
export function viewerSession(document: () => { url: string; html: string }) {
  const isolated = session.fromPartition("canopy-agent-html", { cache: false });

  const configured = isolated.setProxy({
    proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9",
    proxyBypassRules: "<-loopback>",
  });

  isolated.protocol.handle("canopy-agent-html", (request) => {
    const current = document();

    return new Response(request.url === current.url ? current.html : "", {
      status: request.url === current.url ? 200 : 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "X-DNS-Prefetch-Control": "off" },
    });
  });
  isolated.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: details.url !== document().url && !/^(about:|data:|blob:)/.test(details.url) }),
  );
  isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.setDevicePermissionHandler(() => false);
  isolated.on("will-download", (download) => download.preventDefault());

  return { isolated, configured };
}
