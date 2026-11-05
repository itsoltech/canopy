import { pastedCode, returnTarget } from "../../packages/domain/src/oauth-return.ts";

/** Sends a sign-in back to its Canopy; after a few seconds, or when it cannot, offers the code to paste. */
const params = new URLSearchParams(location.search);
const target = returnTarget(location.search);
const status = document.getElementById("status");
const manual = document.getElementById("manual");
const output = document.getElementById("code");
const copy = document.getElementById("copy");

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
  status.textContent = "If Canopy did not open, copy this code and paste it in the Connect dialog.";
  output.textContent = text;
  manual.hidden = false;
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(text).then(
      () => (copy.textContent = "Copied"),
      () => (status.textContent = "Copying is not allowed here. Select the code and copy it."),
    );
  });
}

if (!target) fallback();
else {
  if (target.desktop) location.href = target.url;
  else location.replace(target.url);
  setTimeout(fallback, 3000);
}
