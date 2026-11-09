import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const WORKER_TYPES = new Set(["ordinary", "interactive", "novel"]);

function assertPackage(pkg, workerType) {
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("Worker output must be a JSON object.");
  if (!String(pkg.title || "").trim() || !/^[a-zA-Z0-9._-]{8,180}$/.test(String(pkg.publication_key || ""))) {
    throw new Error("Worker output has no valid title/publication_key.");
  }
  if (typeof pkg.book_content !== "string" || pkg.book_content.trim().length < 100) {
    throw new Error("Worker output has no meaningful book_content.");
  }
  if ((pkg.is_interactive === true) !== (workerType === "interactive")) {
    throw new Error("Worker type does not match the package's interactive flag.");
  }
  if (!pkg.cover || !(pkg.cover.prompt || pkg.cover.url || pkg.cover.base64)) {
    throw new Error("Worker output has no usable cover.");
  }
  if (!Array.isArray(pkg.illustrations) || pkg.illustrations.length < 1 || pkg.illustrations.length > 5) {
    throw new Error("Worker output must contain between one and five illustrations.");
  }
  if (pkg.illustrations.some(item => !item.chapter || !(item.prompt || item.url || item.base64) ||
      !Number.isInteger(Number(item.number)) || Number(item.number) < 1 || Number(item.number) > 5)) {
    throw new Error("Worker output contains an invalid illustration.");
  }
  if (!Array.isArray(pkg.reader_questions) || pkg.reader_questions.length < 3 ||
      pkg.reader_questions.some(item => !item.question || !item.answer)) {
    throw new Error("Worker output must contain at least three complete reader questions.");
  }
  const age = Number.parseInt(String(pkg.age || "6+").replace(/[^0-9]/g, ""), 10) || 0;
  if (age >= 6 && !((pkg.footnotes?.length || 0) > 0 || (pkg.interactive_content?.footnotes?.length || 0) > 0)) {
    throw new Error("Worker output is missing required footnotes.");
  }
  if (workerType === "interactive" && (!pkg.interactive_content || !Array.isArray(pkg.interactive_content.nodes) ||
      pkg.interactive_content.nodes.length < 1)) {
    throw new Error("Interactive worker output has no interactive nodes.");
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function coordinatePackage({ packagePath, root = process.cwd() }) {
  const absoluteRoot = path.resolve(root);
  const relative = path.relative(absoluteRoot, path.resolve(root, packagePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Package path escapes the repository root.");
  const normalized = relative.split(path.sep).join("/");
  const inboxPrefix = "book-publications/inbox/";
  let workerType = null;
  if (!normalized.startsWith(inboxPrefix)) {
    const match = normalized.match(/^book-publications\/workers\/(ordinary|interactive|novel)\/outbox\/[A-Za-z0-9._-]+\.json$/);
    if (!match) throw new Error("Package must be in a known worker outbox or the publication inbox.");
    workerType = match[1];
  } else if (!/^[A-Za-z0-9._-]+\.json$/.test(normalized.slice(inboxPrefix.length))) {
    throw new Error("Invalid inbox package path.");
  }

  const lockPath = path.join(absoluteRoot, "book-publications", ".coordinator.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let lock;
  try {
    lock = await fs.open(lockPath, "wx");
    await lock.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }) + "\n");
    await lock.sync();
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Publication coordinator is already running; refusing concurrent queue writes.");
    throw error;
  }

  try {
    const source = path.join(absoluteRoot, normalized);
    const pkg = await readJson(source);
    if (workerType) assertPackage(pkg, workerType);

    const inboxDir = path.join(absoluteRoot, "book-publications", "inbox");
    const queuePath = path.join(absoluteRoot, "book-publications", "pending-publications.json");
    await fs.mkdir(inboxDir, { recursive: true });
    const queue = await readJson(queuePath);
    queue.packages = Array.isArray(queue.packages) ? queue.packages : [];

    let targetPath = normalized;
    if (workerType) {
      const existingEntry = queue.packages.find(item => item.publication_key === pkg.publication_key);
      if (existingEntry) {
        targetPath = String(existingEntry.path || "");
        if (!targetPath.startsWith(inboxPrefix) || !/^[A-Za-z0-9._-]+\.json$/.test(targetPath.slice(inboxPrefix.length))) {
          throw new Error("Pending queue contains an unsafe path for this publication key.");
        }
      } else {
        const inboxFiles = (await fs.readdir(inboxDir)).filter(name => name.endsWith(".json"));
        for (const name of inboxFiles) {
          const candidatePath = path.join(inboxDir, name);
          const candidate = await readJson(candidatePath);
          if (candidate.publication_key === pkg.publication_key) {
            targetPath = "book-publications/inbox/" + name;
            break;
          }
        }
        if (targetPath === normalized) {
          const safeKey = String(pkg.publication_key).replace(/[^A-Za-z0-9._-]/g, "-");
          const filename = safeKey + "-" + workerType + ".json";
          targetPath = inboxPrefix + filename;
          const destination = path.join(absoluteRoot, targetPath);
          try {
            await fs.writeFile(destination, JSON.stringify(pkg, null, 2) + "\n", { flag: "wx" });
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const collision = await readJson(destination);
            if (collision.publication_key !== pkg.publication_key) throw new Error("Inbox filename collision with a different publication key.");
          }
        }
      }

      const coordinatedFile = path.join(absoluteRoot, targetPath);
      try {
        const existingPackage = await readJson(coordinatedFile);
        if (existingPackage.publication_key !== pkg.publication_key) {
          throw new Error("The pending queue points to an inbox file with a different publication key.");
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await fs.writeFile(coordinatedFile, JSON.stringify(pkg, null, 2) + "\n", { flag: "wx" });
      }

      if (!queue.packages.some(item => item.publication_key === pkg.publication_key)) {
        queue.packages.push({
          path: targetPath,
          title: pkg.title,
          publication_key: pkg.publication_key,
          created_at: new Date().toISOString(),
          worker_type: workerType
        });
        queue.updated_at = new Date().toISOString();
        await writeJsonAtomic(queuePath, queue);
      }
      const workerQueuePath = path.join(absoluteRoot, "book-publications", "workers", workerType, "queue.json");
      let workerQueue = { worker_type: workerType };
      try { workerQueue = await readJson(workerQueuePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      workerQueue.updated_at = new Date().toISOString();
      workerQueue.last_completed = {
        ...(workerQueue.last_completed || {}),
        title: pkg.title,
        publication_key: pkg.publication_key,
        package_path: targetPath,
        status: "queued_for_publication"
      };
      await writeJsonAtomic(workerQueuePath, workerQueue);
      if (source !== path.join(absoluteRoot, targetPath)) await fs.rm(source, { force: true });
      console.log("Coordinated " + workerType + " package " + pkg.publication_key + " -> " + targetPath);
    } else {
      if (!queue.packages.some(item => item.publication_key === pkg.publication_key)) {
        queue.packages.push({ path: targetPath, title: pkg.title, publication_key: pkg.publication_key, created_at: new Date().toISOString() });
        queue.updated_at = new Date().toISOString();
        await writeJsonAtomic(queuePath, queue);
      }
      console.log("Existing inbox package retained: " + targetPath);
    }
    return targetPath;
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const packagePath = process.env.COORDINATOR_PACKAGE_PATH || process.argv[2];
  if (!packagePath) throw new Error("Set COORDINATOR_PACKAGE_PATH or pass a package path.");
  const coordinatedPath = await coordinatePackage({ packagePath });
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=" + coordinatedPath + "\n");
  }
}
