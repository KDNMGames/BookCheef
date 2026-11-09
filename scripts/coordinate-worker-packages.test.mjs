import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { coordinatePackage } from "./coordinate-worker-packages.mjs";

function samplePackage(overrides = {}) {
  return {
    title: "Проверочная книга",
    publication_key: "bookcheef-test-2026-unique",
    book_content: "А".repeat(250),
    is_interactive: false,
    age: "6+",
    cover: { prompt: "A quiet forest under morning light" },
    illustrations: [{ number: 1, chapter: "Глава первая", prompt: "A small cabin in a forest" }],
    reader_questions: [
      { question: "Вопрос первый?", answer: "Ответ первый." },
      { question: "Вопрос второй?", answer: "Ответ второй." },
      { question: "Вопрос третий?", answer: "Ответ третий." }
    ],
    footnotes: [{ word: "лес", text: "Место, где растут деревья." }],
    ...overrides
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookcheef-coordinator-"));
  await fs.mkdir(path.join(root, "book-publications", "inbox"), { recursive: true });
  await fs.mkdir(path.join(root, "book-publications", "workers", "ordinary", "outbox"), { recursive: true });
  await fs.writeFile(path.join(root, "book-publications", "pending-publications.json"), JSON.stringify({ packages: [], updated_at: null }));
  return root;
}

test("coordinator moves a valid worker package into inbox and enqueues it once", async () => {
  const root = await fixture();
  try {
    const source = "book-publications/workers/ordinary/outbox/first.json";
    await fs.writeFile(path.join(root, source), JSON.stringify(samplePackage()));
    const target = await coordinatePackage({ packagePath: source, root });
    assert.match(target, /^book-publications\/inbox\/.+\.json$/);
    const queue = JSON.parse(await fs.readFile(path.join(root, "book-publications/pending-publications.json"), "utf8"));
    assert.equal(queue.packages.length, 1);
    assert.equal(queue.packages[0].publication_key, "bookcheef-test-2026-unique");
    assert.equal((await fs.readFile(path.join(root, target), "utf8")).includes("Проверочная книга"), true);
    await assert.rejects(() => fs.access(path.join(root, source)), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("coordinator is idempotent for the same publication key", async () => {
  const root = await fixture();
  try {
    const first = "book-publications/workers/ordinary/outbox/first.json";
    await fs.writeFile(path.join(root, first), JSON.stringify(samplePackage()));
    const target1 = await coordinatePackage({ packagePath: first, root });
    const second = "book-publications/workers/ordinary/outbox/second.json";
    await fs.writeFile(path.join(root, second), JSON.stringify(samplePackage()));
    const target2 = await coordinatePackage({ packagePath: second, root });
    assert.equal(target2, target1);
    const queue = JSON.parse(await fs.readFile(path.join(root, "book-publications/pending-publications.json"), "utf8"));
    assert.equal(queue.packages.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("coordinator rejects worker type mismatch and paths outside worker outboxes", async () => {
  const root = await fixture();
  try {
    const bad = "book-publications/workers/ordinary/outbox/bad.json";
    await fs.writeFile(path.join(root, bad), JSON.stringify(samplePackage({ is_interactive: true })));
    await assert.rejects(() => coordinatePackage({ packagePath: bad, root }), /does not match/);
    await assert.rejects(() => coordinatePackage({ packagePath: "../secrets.json", root }), /escapes/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
