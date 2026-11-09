import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const workflow = await fs.readFile(".github/workflows/generate-isolated-book-workers.yml", "utf8");

test("isolated generation is manual, production-branch-only, and serialized with daily publishing", () => {
  for (const fragment of [
    "workflow_dispatch:",
    "REF_NAME: ${{ github.ref }}",
    "refs/heads/main",
    "group: bookcheef-daily-book-generation"
  ]) assert.ok(workflow.includes(fragment), "Missing workflow contract: " + fragment);
});

test("worker artifact is downloaded into the coordinator's expected directory", () => {
  for (const fragment of [
    "name: ${{ inputs.worker_type }}",
    "path: worker-artifacts/${{ inputs.worker_type }}",
    "uses: actions/download-artifact@v4",
    'cp -a "worker-artifacts/${{ inputs.worker_type }}/."'
  ]) assert.ok(workflow.includes(fragment), "Missing artifact handoff contract: " + fragment);
});

test("coordinator persists state and has permission to dispatch the publisher", () => {
  for (const fragment of [
    "actions: write",
    "node scripts/coordinate-worker-artifacts.mjs",
    "git add -A book-publications/workers",
    "actions/workflows/publish-book.yml/dispatches"
  ]) assert.ok(workflow.includes(fragment), "Missing coordinator contract: " + fragment);
});
