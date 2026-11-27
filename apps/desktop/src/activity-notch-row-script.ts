import { activityNotchLogoSize } from "@canopy/ui/desktop";
import { icons, iconStyle } from "@canopy/ui/icons";
import { providerColors, providerPaths } from "@canopy/ui/provider-icons";
import { harnessName } from "@canopy/domain/harnesses";
import { Provider } from "@canopy/contracts";
import { providerKeys } from "@canopy/ui/providers";
import { threadRowMarks } from "@canopy/ui/thread-row";

const icon = (paths: readonly string[]) =>
  `<svg class="place-icon" viewBox="${iconStyle.viewBox}" fill="none" stroke="currentColor" stroke-width="${iconStyle.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;

const providers = Object.fromEntries(
  providerKeys.map((key) => [
    key,
    {
      name: harnessName(Provider[key]),
      svg: `<svg viewBox="0 0 24 24" fill="${key === "CLAUDE" ? providerColors.CLAUDE : providerColors.dark}" opacity="${threadRowMarks.providerOpacity}" aria-hidden="true"><path d="${providerPaths[key]}"/></svg>`,
    },
  ]),
);

/**
 * Row views for the notch page, laid out like a sidebar thread row: the project mark and name with the status,
 * the title, then the worker and directory, the branch (its middle gives way first) and the provider mark.
 */
export const activityNotchRowScript = `
  const logoSize = ${activityNotchLogoSize};
  const logoBytes = logoSize * logoSize * 4;
  const encodedLogoLength = Math.ceil(logoBytes / 3) * 4;
  const providers = ${JSON.stringify(providers)};
  const placeMarkup = ${JSON.stringify(
    `<span class="row-worker">${icon(icons["computer-desktop"])}<span class="truncate"></span></span>` +
      `<span class="row-branch">${icon(icons["git-fork"])}<span class="branch-swap swap"></span></span>` +
      `<span class="row-provider"></span>`,
  )};

  function setText(element, text, title) {
    if (element.textContent !== text) element.textContent = text;
    if (title !== undefined && element.title !== title) element.title = title;
  }

  function createRow(id) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const badge = document.createElement("span");
    const project = document.createElement("span");
    const label = document.createElement("span");
    const place = document.createElement("span");
    const status = document.createElement("span");
    button.type = "button";
    button.className = "row";
    badge.className = "row-mark";
    badge.setAttribute("aria-hidden", "true");
    badge.setAttribute("data-empty", "");
    project.className = "row-project truncate";
    project.dir = "auto";
    label.className = "row-title swap";
    place.className = "row-place";
    place.hidden = true;
    place.innerHTML = placeMarkup;
    status.className = "row-status";
    status.setAttribute("aria-hidden", "true");
    for (const [state, { label }] of Object.entries(statuses)) {
      const layer = document.createElement("span");
      layer.className = "status state-layer";
      layer.dataset.state = state;
      layer.textContent = label;
      status.append(layer);
    }
    button.append(badge, project, status, label, place);
    item.append(button);
    button.addEventListener("click", () => bridge.open(id));
    const [worker, branch, provider] = place.children;
    return { item, button, badge, project, label, place, worker, branch, provider, status };
  }

  function setTitle(view, label, animate) {
    view.label.title = label;
    swapText(view.label, label, (layer) => {
      layer.classList.add("truncate");
      layer.dir = "auto";
      layer.textContent = label;
    }, animate);
  }

  function updateRowMeta(view, meta, bot, animate) {
    setText(view.project, bot ? "Bot" : meta?.project ?? "", bot ? "" : meta?.project ?? "");

    const where = [meta?.worker, meta?.place].filter(Boolean).join(" · ");
    view.worker.hidden = !where;
    view.worker.querySelector(".place-icon").style.display = meta?.worker ? "" : "none";
    setText(view.worker.lastElementChild, where, where);

    const branch = meta?.branch ?? "";
    const split = branch.length - Math.min(8, Math.floor(branch.length / 2));
    view.branch.hidden = !branch;
    view.branch.title = meta?.branchLabel ?? branch;
    swapText(view.branch.lastElementChild, branch, (layer) => {
      const start = document.createElement("span");
      const end = document.createElement("span");
      layer.classList.add("branch-name");
      start.className = "branch-start";
      end.className = "branch-end";
      start.textContent = branch.slice(0, split);
      end.textContent = branch.slice(split);
      layer.append(start, end);
    }, animate);

    const provider = providers[meta?.provider];
    if (view.providerKey !== meta?.provider) {
      view.provider.innerHTML = provider?.svg ?? "";
      view.provider.title = provider?.name ?? "";
      view.providerKey = meta?.provider;
    }
    view.place.hidden = !where && !branch && !provider;
  }

  function placeDescription(meta) {
    const branch = meta?.branchLabel || meta?.branch;
    const provider = providers[meta?.provider]?.name;
    const parts = [meta?.worker, meta?.place, branch, provider].filter(Boolean);
    return parts.length ? ", " + parts.join(", ") : "";
  }

  function projectLogo(pixels) {
    if (pixels?.length !== encodedLogoLength) return;

    let decoded;
    try {
      decoded = atob(pixels);
    } catch {
      return;
    }
    if (decoded.length !== logoBytes) return;

    const canvas = document.createElement("canvas");
    canvas.width = logoSize;
    canvas.height = logoSize;
    const context = canvas.getContext("2d");
    if (!context) return;

    const rgba = Uint8ClampedArray.from(decoded, (byte) => byte.charCodeAt(0));
    context.putImageData(new ImageData(rgba, logoSize, logoSize), 0, 0);
    return canvas;
  }

  function updateRowMark(view, mark, mascot) {
    const previous = view.projectMark;
    if (
      view.botMascot === mascot &&
      previous?.initials === mark?.initials &&
      previous?.foreground === mark?.foreground &&
      previous?.background === mark?.background &&
      previous?.pixels === mark?.pixels
    ) return;

    const image = mascot ? document.createElement("img") : projectLogo(mark?.pixels);
    if (mascot) {
      image.alt = "";
      image.src = mascot;
    }
    view.badge.replaceChildren(image ?? mark?.initials ?? "");
    view.badge.style.color = mark?.foreground ?? "";
    view.badge.style.backgroundColor = image ? "" : mark?.background ?? "";
    // Like the sidebar, a thread without a project mark keeps a dashed placeholder in its place.
    view.badge.toggleAttribute("data-empty", !mark && !mascot);
    view.projectMark = mark;
    view.botMascot = mascot;
  }
`;
