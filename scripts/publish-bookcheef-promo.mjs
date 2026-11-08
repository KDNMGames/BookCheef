import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN GitHub secret is missing.");

const sha = process.env.GITHUB_SHA || "HEAD";
const changed = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha], { encoding: "utf8" });
const launchFiles = changed.split(/\r?\n/).filter((file) => /^marketing\/launch\/[^/]+\.json$/.test(file));

function exposeReportPath(reportFile) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `report_file=${reportFile}\n`);
  }
}

if (!launchFiles.length) {
  console.log("No launch campaign JSON changed in this commit.");
  process.exit(0);
}

for (const launchFile of launchFiles) {
  const campaign = JSON.parse(fs.readFileSync(path.resolve(launchFile), "utf8"));
  if (!campaign.campaign_id || !campaign.post_text || typeof campaign.post_text !== "string") {
    throw new Error(`Invalid campaign file: ${launchFile}`);
  }

  const slug = String(campaign.campaign_id).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const reportFile = path.join("marketing", "outbox", `${new Date().toISOString().slice(0, 10)}-telegram-${slug}.json`);
  if (fs.existsSync(reportFile)) {
    console.log(`Already reported; skipping duplicate: ${reportFile}`);
    exposeReportPath(reportFile);
    continue;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: campaign.chat_id || "@BookCheef",
      text: campaign.post_text,
      disable_web_page_preview: false,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok || !result.result?.message_id) {
    throw new Error(`Telegram publication failed: HTTP ${response.status} ${JSON.stringify(result)}`);
  }

  const publishedAt = new Date().toISOString();
  const messageId = result.result.message_id;
  const report = {
    status: "published",
    report_id: campaign.campaign_id,
    platform: "Telegram",
    community_name: "@BookCheef",
    community_url: "https://t.me/BookCheef",
    post_url: `https://t.me/BookCheef/${messageId}`,
    published_at: publishedAt,
    destination: "Публичный канал @BookCheef",
    post_text: campaign.post_text,
  };

  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  exposeReportPath(reportFile);
  console.log(`Published ${campaign.campaign_id}; Telegram message ${messageId}; report: ${reportFile}`);
}
