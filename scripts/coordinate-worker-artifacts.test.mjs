import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { coordinateWorkerArtifacts } from "./coordinate-worker-artifacts.mjs";

function samplePackage(workerType, overrides = {}) {
  return {
    title: "Тестовая книга " + workerType,
    publication_key: "artifact-test-" + workerType + "-2026",
    book_content: "А".repeat(250),
    is_interactive: workerType === "interactive",
    age: "6+",
    cover: { prompt: "A quiet forest under morning light" },
    illustrations: [{ number: 1, chapter: "Глава первая", prompt: "A small cabin in a forest" }],
    reader_questions: [
      { question: "Вопрос первый?", answer: "Ответ первый." },
      { question: "Вопрос второй?", answer: "Ответ второй." },
      { question: "Вопрос третий?", answer: "Ответ третий." }
    ],
    footnotes: [{ word: "лес", text: "Место, где растут деревья." }],
    ...(workerType === "interactive" ? { interactive_content: { nodes: [{ id: "start", text: "Начало" }] } } : {}),
    ...overrides
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookcheef-artifacts-"));
  await fs.mkdir(path.join(root, "book-publications", "inbox"), { recursive: true });
  await fs.writeFile(path.join(root, "book-publications", "pending-publications.json"), JSON.stringify({ packages: [], updated_at: null }));
  for (const type of ["ordinary", "interactive", "novel"]) {
    await fs.mkdir(path.join(root, "worker-artifacts", type, "outbox"), { recursive: true });
  }
  return root;
}

test("artifact coordinator imports all worker types sequentially into one queue", async () => {
  const root = await fixture();
  try {
    for (const type of ["ordinary", "interactive", "novel"]) {
      await fs.writeFile(
        path.join(root, "worker-artifacts", type, "outbox", type + ".json"),
        JSON.stringify(samplePackage(type))
      );
    }
    const results = await coordinateWorkerArtifacts({ artifactRoot: "worker-artifacts", repoRoot: root });
    assert.equal(results.length, 3);
    assert.deepEqual(results.map(item => item.worker_type), ["ordinary", "interactive", "novel"]);
    const queue = JSON.parse(await fs.readFile(path.join(root, "book-publications", "pending-publications.json"), "utf8"));
    assert.equal(queue.packages.length, 3);
    for (const item of results) {
      assert.match(item.package_path, /^book-publications\/inbox\/.+\.json$/);
      await assert.rejects(() => fs.access(path.join(root, item.source)), { code: "ENOENT" });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("artifact coordinator is safe to retry after partial handoff", async () => {
  const root = await fixture();
  try {
    const ordinary = path.join(root, "worker-artifacts", "ordinary", "outbox", "ordinary.json");
    await fs.writeFile(ordinary, JSON.stringify(samplePackage("ordinary")));
    const first = await coordinateWorkerArtifacts({ artifactRoot: "worker-artifacts", repoRoot: root });
    assert.equal(first.length, 1);
    const second = await coordinateWorkerArtifacts({ artifactRoot: "worker-artifacts", repoRoot: root });
    assert.equal(second.length, 0);
    const queue = JSON.parse(await fs.readFile(path.join(root, "book-publications", "pending-publications.json"), "utf8"));
    assert.equal(queue.packages.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("artifact coordinator rejects artifact roots outside the repository", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      () => coordinateWorkerArtifacts({ artifactRoot: "../outside", repoRoot: root }),
      /child directory/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
