import fs from "node:fs/promises";
import path from "node:path";
import { coordinatePackage } from "./coordinate-worker-packages.mjs";

const WORKER_TYPES = ["ordinary", "interactive", "novel"];

export async function coordinateWorkerArtifacts({ artifactRoot, repoRoot = process.cwd() }) {
  const absoluteArtifacts = path.resolve(repoRoot, artifactRoot);
  const relativeArtifacts = path.relative(path.resolve(repoRoot), absoluteArtifacts);
  if (!relativeArtifacts || relativeArtifacts.startsWith("..") || path.isAbsolute(relativeArtifacts)) {
    throw new Error("Artifact root must be a child directory of the repository.");
  }

  const coordinated = [];
  for (const workerType of WORKER_TYPES) {
    const outbox = path.join(absoluteArtifacts, workerType, "outbox");
    let names = [];
    try {
      names = (await fs.readdir(outbox)).filter(name => name.endsWith(".json")).sort();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    for (const name of names) {
      if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) {
        throw new Error("Unsafe worker artifact filename: " + name);
      }
      const absolutePackage = path.join(outbox, name);
      const relativePackage = path.relative(path.resolve(repoRoot), absolutePackage).split(path.sep).join("/");
      const target = await coordinatePackage({ packagePath: relativePackage, root: repoRoot });
      coordinated.push({ worker_type: workerType, source: relativePackage, package_path: target });
      console.log("Imported " + workerType + " artifact " + name + " -> " + target);
    }
  }
  return coordinated;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const artifactRoot = process.env.BOOKCHEEF_ARTIFACT_ROOT || process.argv[2];
  if (!artifactRoot) throw new Error("Set BOOKCHEEF_ARTIFACT_ROOT or pass an artifact root directory.");
  const coordinated = await coordinateWorkerArtifacts({ artifactRoot });
  if (process.env.GITHUB_OUTPUT) {
    const delimiter = "BOOKCHEEF_" + process.pid + "_OUTPUT";
    await fs.appendFile(process.env.GITHUB_OUTPUT,
      "package_paths<<"+delimiter+"\n"+coordinated.map(item => item.package_path).join("\n")+"\n"+delimiter+"\n");
    await fs.appendFile(process.env.GITHUB_OUTPUT, "package_count=" + coordinated.length + "\n");
  }
  console.log("Coordinated " + coordinated.length + " worker artifact package(s).");
}
