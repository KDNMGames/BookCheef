import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const before = process.env.GITHUB_EVENT_BEFORE || "";
const after = process.env.GITHUB_SHA || "HEAD";
const zeroSha = /^0+$/.test(before);
const changed = zeroSha
  ? execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", after], { encoding: "utf8" })
  : execFileSync("git", ["diff", "--name-only", before, after], { encoding: "utf8" });
const manualFile = process.argv[2] || "";
const files = manualFile
  ? [manualFile]
  : changed.split(/\r?\n/).filter((p) => /^marketing\/outbox\/[^/]+\.json$/.test(p));

if (!files.length) {
  console.log("No marketing publication reports in this push.");
  process.exit(0);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const endpoint = "https://wendffewxxmnaglfksfg.supabase.co/functions/v1/telegram-bot";
if (!token) throw new Error("TELEGRAM_BOT_TOKEN GitHub secret is missing.");

for (const file of files) {
  const report = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  if (report.status !== "published") {
    console.log(`Skipping non-published report: ${file}`);
    continue;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bookcheef-report-token": token,
    },
    body: JSON.stringify({ action: "marketing_report", report }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram report failed for ${file}: HTTP ${response.status} ${JSON.stringify(result)}`);
  }
  console.log(`Report delivered for ${file}: ${result.delivered}/${result.total} admin chats.`);
}
