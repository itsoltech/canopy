import { create } from "@bufbuild/protobuf";
import { AgentPreviewTargetSchema, AgentTool, type AgentPreviewTarget } from "@canopy/contracts";

export function previewWindowPath(
  threadId: string,
  workerId: string,
  tool: AgentTool,
  fit: "fit" | "actual",
  target?: AgentPreviewTarget,
): string {
  const selection = new URLSearchParams({ tool: String(tool), fit });

  if (workerId && target && tool !== AgentTool.BROWSER) {
    selection.set("worker", workerId);
    selection.set("platform", target.platform);

    if (tool === AgentTool.DEVICE) selection.set("device", target.deviceId);
    else {
      selection.set("app", target.app);
      selection.set("window", target.windowId);
    }
  }

  return `/threads/${encodeURIComponent(threadId)}/preview#${selection}`;
}

/** The fragment carries initial choices only and is removed after the page reads it. */
export function initialPreviewChoice(hash: string) {
  const params = new URLSearchParams(hash.slice(1));
  const requestedTool = Number(params.get("tool"));

  const tool =
    requestedTool === AgentTool.DESKTOP || requestedTool === AgentTool.DEVICE ? requestedTool : AgentTool.BROWSER;

  const fit: "fit" | "actual" = params.get("fit") === "actual" ? "actual" : "fit";
  const workerId = params.get("worker") ?? "";

  const target =
    workerId && tool !== AgentTool.BROWSER
      ? create(AgentPreviewTargetSchema, {
          platform: params.get("platform") ?? "",
          app: params.get("app") ?? "",
          windowId: params.get("window") ?? "",
          deviceId: params.get("device") ?? "",
        })
      : undefined;

  return { tool, fit, workerId, target };
}

export async function openPreviewWindow(path: string): Promise<boolean> {
  const desktop = window.canopyDesktop;

  if (desktop) {
    if (!desktop.openPreviewWindow) return false;
    await desktop.openPreviewWindow(path);

    return true;
  }

  const popup = window.open("", "_blank", "popup,width=1000,height=720");

  if (!popup) return false;

  try {
    // Only the initial about:blank has an opener. Sever it before loading Canopy.
    popup.opener = null;
    popup.location.replace(new URL(path, window.location.origin).href);

    return true;
  } catch (cause) {
    popup.close();
    throw cause;
  }
}
