const remove = {
  element(element: HTMLRewriterTypes.Element) {
    element.remove();
  },
};

// Android displays the central 72 dp of a 108 dp layer. Center the 128-unit
// drawing in a 256-unit viewBox so even the Dev dimension line fits its 66 dp safe circle.
function adaptiveCanvas() {
  return new HTMLRewriter().on("svg", {
    element(svg) {
      svg.setAttribute("viewBox", "-64 -64 256 256");
    },
  });
}

export function nativeLayers(master: Buffer) {
  const svg = master.toString("utf8");

  // In each master the top-level rectangles paint the tile, including the Dev
  // grid. The transformed group draws the tree. The other paths and groups draw the accents.
  const fullBleed = new HTMLRewriter()
    .on("svg > rect", {
      element(rect) {
        rect.removeAttribute("rx");
        rect.removeAttribute("ry");
      },
    })
    .transform(svg);

  const foreground = adaptiveCanvas().on("svg > rect", remove).transform(svg);

  const background = adaptiveCanvas()
    .on("svg > path, svg > g", remove)
    .on("svg > rect", {
      element(rect) {
        rect.setAttribute("x", "-64");
        rect.setAttribute("y", "-64");
        rect.setAttribute("width", "256");
        rect.setAttribute("height", "256");
      },
    })
    .transform(fullBleed);

  const tree = new HTMLRewriter().on("svg > rect, svg > path, svg > g:not([transform])", remove).transform(svg);

  return {
    fullBleed: Buffer.from(fullBleed),
    foreground: Buffer.from(foreground),
    background: Buffer.from(background),
    tree: Buffer.from(tree),
  };
}
