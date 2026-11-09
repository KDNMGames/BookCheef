import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const workflow = await fs.readFile(".github/workflows/generate-isolated-book-workers.yml", "utf8");

test("isolated generation is manual, production-branch-only, and serialized with daily publishing", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /REF_NAME: \\?\$\\?\{\\?\\? github\\.ref \\?\}/);
  assert.match(workflow, /refs\\/heads\\/main/);
  assert.match(workflow, /group: bookcheef-daily-book-generation/);
});

test("worker artifact is downloaded into the coordinator's expected directory", () => {
  assert.match(workflow, /name: \\?\$\\?\{\\?\\? inputs\\.worker_type \\?\}/);
  assert.match(workflow, /path: worker-artifacts\\/\\$\\?\{\\?\\? inputs\\.worker_type \\?\}/);
  assert.match(workflow, /uses: actions\\/download-artifact@v4/);
  assert.match(workflow, /cp -a "worker-artifacts\\/\\$\\?\{\\?\\? inputs\\.worker_type \\?\}\\/\\."/);
});

test("coordinator persists state and has permission to dispatch the publisher", () => {
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /node scripts\\/coordinate-worker-artifacts\\.mjs/);
  assert.match(workflow, /git add -A book-publications\\/workers/);
  assert.match(workflow, /actions\\/workflows\\/publish-book\\.yml\\/dispatches/);
});
