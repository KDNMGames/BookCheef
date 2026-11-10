import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLegacyInteractivePackage } from "./legacy-interactive-book.mjs";

test("migrates legacy object-shaped interactive nodes and extracts choices", () => {
  const pkg = {
    is_interactive: true,
    nodes: {
      "scene-1": {
        title: "Приём сигнала",
        content: "Сцена первая.\n\n{{illustration:scene-1:1}}\n\nchoices: [\n  {text: \"Ответить\", next: \"scene-2a\"},\n  {text: \"Промолчать\", next: \"scene-2b\"}\n]"
      },
      "scene-2a": { title: "Ответ", content: "Сцена вторая. choices: [{text: \"Финал\", next: \"ending-a\"}]" },
      "scene-2b": { title: "Молчание", content: "Сцена третья. choices: [{text: \"Финал\", next: \"ending-b\"}]" },
      "ending-a": { title: "Финал А", content: "Конец А. choices: []" },
      "ending-b": { title: "Финал Б", content: "Конец Б. choices: []" }
    },
    illustrations: [
      { number: 1, chapter: "scene-1" },
      { number: 2, chapter: "scene-2a" },
      { number: 3, chapter: "scene-2b" },
      { number: 4, chapter: "ending-a" },
      { number: 5, chapter: "ending-b" }
    ]
  };

  normalizeLegacyInteractivePackage(pkg);
  assert.equal(pkg.is_interactive, true);
  assert.equal(pkg.nodes, undefined);
  assert.equal(pkg.interactive_content.nodes.length, 5);
  assert.deepEqual(pkg.interactive_content.nodes[0].choices, [
    { text: "Ответить", next: "scene-2a" },
    { text: "Промолчать", next: "scene-2b" }
  ]);
  assert.equal(pkg.interactive_content.nodes[0].text, "Сцена первая.");
  assert.equal(pkg.interactive_content.nodes[0].image_start, "{{illustration:scene-1:1}}");
  assert.equal(pkg.illustrations[0].chapter, "Приём сигнала");
});

test("leaves ordinary packages without interactive nodes unchanged", () => {
  const pkg = { is_interactive: false, book_content: "Ordinary book" };
  assert.equal(normalizeLegacyInteractivePackage(pkg), pkg);
});
