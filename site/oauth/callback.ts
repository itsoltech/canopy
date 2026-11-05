import { pastedCode, returnTarget } from "../../packages/domain/src/oauth-return.ts";

/**
 * Sends a sign-in back to its Canopy. A browser may block opening the desktop app without a click, so an
 * "Open Canopy" link and the code to paste show right away; the status line changes once the automatic return
 * had time to happen.
 */
const params = new URLSearchParams(location.search);
const target = returnTarget(location.search);
const status = document.getElementById("status");
const manual = document.getElementById("manual");
const output = document.getElementById("code");
const copy = document.getElementById("copy");
const open = document.getElementById("open");

// The code must not stay in history or a restored session.
history.replaceState(null, "", location.pathname);

function fallback() {
  const state = params.get("state");
  const code = params.get("code");

  if (!status || !manual || !output || !copy) return;

  if (!target || !state || !code) {
    status.textContent = target
      ? "Sign-in did not finish. Start it again in Canopy."
      : "This sign-in link is not valid. Start sign-in again in Canopy.";

    return;
  }

  const text = pastedCode(state, code);
  output.textContent = text;
  manual.hidden = false;
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(text).then(
      () => (copy.textContent = "Copied"),
      () => (status.textContent = "Copying is not allowed here. Select the code and copy it."),
    );
  });
}

const missed = "If Canopy did not open, select Open Canopy, or copy this code and paste it in the Connect dialog.";

if (!target) fallback();
else {
  fallback();

  if (open && target.desktop) {
    open.setAttribute("href", target.url);
    open.hidden = false;
  }

  if (target.desktop) location.href = target.url;
  else location.replace(target.url);
  setTimeout(() => {
    if (status && params.get("code")) status.textContent = missed;
  }, 3000);
}
