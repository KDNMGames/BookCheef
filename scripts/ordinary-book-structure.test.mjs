import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOrdinaryBookStructure } from "./ordinary-book-structure.mjs";

test("normalizes plain Russian chapter labels and remaps only defined illustrations", () => {
  const pkg = {
    book_content: [
      "Книга\nКороткое вступление.",
      "Глава 1: Первый сигнал\nТекст первой главы.",
      "{{illustration:Книга:2}}",
      "Глава 2: Второй шаг\nТекст второй главы.",
      "{{illustration:Книга:3}}"
    ].join("\n\n"),
    illustrations: [
      { number: 1, chapter: "Книга:1", prompt: "one" },
      { number: 2, chapter: "Книга:2", prompt: "two" }
    ]
  };

  normalizeOrdinaryBookStructure(pkg);

  assert.match(pkg.book_content, /^## Глава 1: Первый сигнал/m);
  assert.match(pkg.book_content, /^## Глава 2: Второй шаг/m);
  assert.deepEqual(pkg.illustrations.map(x => x.chapter), [
    "Глава 1: Первый сигнал",
    "Глава 2: Второй шаг"
  ]);
  assert.equal((pkg.book_content.match(/\{\{illustration:/g) || []).length, 2);
  assert.ok(pkg.book_content.includes("{{illustration:Глава 1: Первый сигнал:1}}"));
  assert.ok(pkg.book_content.includes("{{illustration:Глава 2: Второй шаг:2}}"));
});

test("leaves a package without chapter headings intact", () => {
  const pkg = { book_content: "A short book", illustrations: [{ number: 1, chapter: "Book", prompt: "p" }] };
  assert.equal(normalizeOrdinaryBookStructure(pkg).book_content, "A short book");
});
