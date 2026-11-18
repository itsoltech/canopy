import type { themeVariables } from "@canopy/ui/themes";

export function shutdownStatus(installingUpdate: boolean) {
  return installingUpdate
    ? { title: "Restarting Canopy…", detail: "Stopping services before installing the update." }
    : { title: "Closing Canopy…", detail: "Saving the latest state and stopping services." };
}

/** Only fixed copy and trusted palette literals enter this script-free document. */
export function shutdownPage(installingUpdate: boolean, colors: ReturnType<typeof themeVariables>) {
  const { title, detail } = shutdownStatus(installingUpdate);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${title}</title>
  <style>
    :root { --duration-very-slow: 500ms; --ease-linear: linear; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100dvh; padding: 2rem;
      display: flex; align-items: center; justify-content: center;
      background: ${colors.canvas}; color: ${colors.ink};
      font-family: system-ui, sans-serif; -webkit-font-smoothing: antialiased;
      -webkit-app-region: drag;
    }
    main { display: flex; flex-direction: column; align-items: center; gap: 1rem; min-width: 0; }
    .spinner {
      width: 1.5rem; height: 1.5rem; flex-shrink: 0; border-radius: 50%;
      border: 2px solid ${colors.border}; border-top-color: ${colors.accent};
      animation: spin calc(var(--duration-very-slow) * 2) var(--ease-linear) infinite;
    }
    .copy { display: flex; flex-direction: column; gap: .5rem; text-align: center; }
    h1 { margin: 0; font-size: 1.125rem; font-weight: 500; text-wrap: balance; }
    p { margin: 0; max-width: 34ch; font-size: 1rem; line-height: 1.5rem; color: ${colors.muted}; text-wrap: pretty; }
    @media (min-width: 40rem) { p { font-size: .875rem; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  </style>
</head>
<body>
  <main role="status" aria-label="${title}">
    <div class="spinner" aria-hidden="true"></div>
    <div class="copy"><h1>${title}</h1><p>${detail}</p></div>
  </main>
</body>
</html>`;
}
