export function normalizeLegacyInteractivePackage(pkg) {
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return pkg;

  let sourceNodes = pkg.interactive_content?.nodes ?? pkg.nodes;
  if (sourceNodes && !Array.isArray(sourceNodes) && typeof sourceNodes === "object") {
    sourceNodes = Object.entries(sourceNodes).map(([id, node]) => ({ id, ...(node || {}) }));
  }
  if (!Array.isArray(sourceNodes) || sourceNodes.length !== 5) return pkg;

  const nodes = sourceNodes.map((node, index) => {
    const id = String(node.id || ["scene-1", "scene-2a", "scene-2b", "ending-a", "ending-b"][index]);
    const raw = String(node.text || node.content || "");
    const marker = raw.match(/\{\{illustration:[^}]+\}\}/)?.[0] || node.image_start || "";
    const choicesBlock = raw.match(/choices\s*:\s*\[([\s\S]*?)\]\s*$/i);
    const parsedChoices = choicesBlock
      ? [...choicesBlock[1].matchAll(/\{\s*text:\s*["']([^"']+)["']\s*,\s*next:\s*["']([^"']+)["']\s*\}/g)]
        .map(match => ({ text: match[1], next: match[2] }))
      : [];
    const choices = Array.isArray(node.choices) ? node.choices : parsedChoices;
    const text = raw
      .replace(/choices\s*:\s*\[[\s\S]*?\]\s*$/i, "")
      .replace(/\{\{illustration:[^}]+\}\}/g, "")
      .trim();
    return {
      id,
      title: String(node.title || id),
      text,
      choices,
      image_start: marker,
      image_start_alt: String(node.image_start_alt || ("Illustration for " + String(node.title || id)))
    };
  });

  pkg.interactive_content = {
    start: pkg.interactive_content?.start || "scene-1",
    footnotes: pkg.interactive_content?.footnotes || pkg.footnotes || [],
    nodes
  };
  pkg.is_interactive = true;
  delete pkg.nodes;

  if (Array.isArray(pkg.illustrations)) {
    for (let i = 0; i < pkg.illustrations.length; i++) {
      const illustration = pkg.illustrations[i];
      if (!illustration) continue;
      const node = nodes.find(item => item.id === String(illustration.chapter || "")) || nodes[i];
      if (node) illustration.chapter = node.title;
      illustration.number = i + 1;
    }
  }
  return pkg;
}
