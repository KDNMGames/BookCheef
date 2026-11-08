import fs from "node:fs/promises";
import path from "node:path";

export function createCheckpointStore({ workPath, bookType, logger = console }) {
  if (!workPath || !bookType) throw new Error("Checkpoint store requires workPath and bookType.");

  async function saveWork(pkg) {
    if (!pkg || typeof pkg.title !== "string" || !pkg.title.trim() ||
        typeof pkg.book_content !== "string" || !pkg.book_content.trim()) {
      throw new Error("Cannot save an incomplete book checkpoint.");
    }
    await fs.mkdir(path.dirname(workPath), { recursive: true });
    const state = {
      version: 1,
      book_type: bookType,
      updated_at: new Date().toISOString(),
      pkg
    };
    await fs.writeFile(workPath, JSON.stringify(state, null, 2) + "\n");
  }

  async function loadWork() {
    try {
      const state = JSON.parse(await fs.readFile(workPath, "utf8"));
      if (state.version !== 1 || state.book_type !== bookType ||
          !state.pkg?.title || !state.pkg?.book_content) {
        throw new Error("Saved work checkpoint does not match the current rotation or is incomplete.");
      }
      logger.log("Resuming saved book: " + state.pkg.title);
      return state.pkg;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  return { saveWork, loadWork };
}
