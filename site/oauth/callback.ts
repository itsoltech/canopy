import { isOAuthState, pastedCode, returnTarget } from "../../packages/domain/src/oauth-return.ts";

/**
 * Sends a sign-in back to its Canopy. A browser may block opening the desktop app without a click, so the
 * page offers an "Open Canopy" link and a disclosure for the sign-in code.
 */
const params = new URLSearchParams(location.search);
const target = returnTarget(location.search);

// Only the callback for registered clients can forward codes to a web installation.
const webReturn = document.body.hasAttribute("data-web-return");
const automaticReturn = target && (webReturn || target.desktop) ? target : undefined;
const status = document.getElementById("status");
const manual = document.getElementById("manual");
const output = document.getElementById("code");
const copy = document.getElementById("copy");
const copyFeedback = document.getElementById("copy-feedback");
const open = document.getElementById("open");

// The code must not stay in history or a restored session.
history.replaceState(null, "", location.pathname);

function fallback() {
  const state = params.get("state");
  const code = params.get("code");

  if (!status || !(manual instanceof HTMLDetailsElement) || !output || !copy || !copyFeedback) return;

  // A plain nonce has no forwarding destination. The originating client accepts a manual return.
  const manualReturn = state && isOAuthState(state) && !state.includes(".");
  const valid = target || manualReturn || (!webReturn && state && isOAuthState(state));

  if (!valid || !state || !code) {
    status.textContent = valid
      ? "Sign-in did not finish. Start it again in Canopy."
      : "This sign-in link is not valid. Start sign-in again in Canopy.";

    return;
  }

  const text = pastedCode(state, code);
  output.textContent = text;

  if (!automaticReturn) {
    const summary = manual.querySelector("summary");

    if (summary) summary.hidden = true;

    manual.open = true;
    status.hidden = true;
  }

  manual.hidden = false;

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      copyFeedback.textContent = "";
    } catch {
      copy.textContent = "Copy code";
      copyFeedback.textContent = "Couldn’t copy the code. Select and copy it manually.";
    }
  });
}

fallback();

if (automaticReturn) {
  if (open && automaticReturn.desktop) {
    open.setAttribute("href", automaticReturn.url);
    open.hidden = false;
  }

  if (automaticReturn.desktop) location.href = automaticReturn.url;
  else location.replace(automaticReturn.url);
  setTimeout(() => {
    if (status && params.get("code")) status.textContent = "Continue in Canopy to connect your account.";
  }, 3000);
}
