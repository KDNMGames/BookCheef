import fs from "node:fs";
import path from "node:path";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const platformsFile = "marketing/platforms.json";
const campaignsFile = "marketing/campaigns.json";
const platformsData = readJson(platformsFile);
const campaignsData = readJson(campaignsFile);
const platforms = Array.isArray(platformsData.platforms) ? platformsData.platforms : [];
const campaigns = Array.isArray(campaignsData.campaigns) ? campaignsData.campaigns : [];

const counts = { auto_allowed: 0, manual_only: 0, review_required: 0, blocked: 0, other: 0 };
for (const platform of platforms) {
  if (Object.hasOwn(counts, platform.status)) counts[platform.status]++;
  else counts.other++;
}

const eligible = platforms.filter((p) =>
  p.status === "auto_allowed" &&
  p.scope !== "own_channel" &&
  p.scope !== "own_community" &&
  p.mode === "official_api" &&
  p.rules_url &&
  p.last_checked
);

const now = new Date().toISOString();
const lines = [
  "# BookCheef marketing cycle audit",
  "",
  `- Checked at: ${now}`,
  `- Registered platforms: ${platforms.length}`,
  `- Campaign records: ${campaigns.length}`,
  `- auto_allowed: ${counts.auto_allowed}`,
  `- manual_only: ${counts.manual_only}`,
  `- review_required: ${counts.review_required}`,
  `- blocked: ${counts.blocked}`,
  `- other statuses: ${counts.other}`,
  "",
  "## Publication gate",
  "",
  eligible.length
    ? `Potentially eligible records: ${eligible.map((p) => p.id).join(", ")}. This audit does not publish; the publication workflow still requires a separate campaign JSON with explicit rules_verified, automation_allowed and destination_approved flags.`
    : "No platform currently meets the conservative auto-publication registry gate. No posts or messages were sent.",
  "",
  "## Connector limitations",
  "",
  "- This GitHub runner has no authenticated Gmail connector session; it does not send outreach email.",
  "- Weekly community discovery runs separately from public Russian-language RSS feeds; it only creates candidates and never verifies permissions or publishes.",
  "- Manual/review-required destinations remain untouched.",
  "- The owned @BookCheef channel is excluded from acquisition advertising.",
  "",
  "## Next actions",
  "",
  "- Add a platform only after checking its current first-party rules and recording the rules URL and check date.",
  "- Obtain explicit admin permission and official publishing API access before changing any platform to auto_allowed.",
  "- GitHub Actions still has no Gmail API credentials; no email is sent by this runner. Gmail connector access in ChatGPT is separate."
];

const output = path.join("marketing", "reports", "scheduled-cycle-latest.md");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, lines.join("\n") + "\n", "utf8");

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) fs.appendFileSync(summary, lines.join("\n") + "\n");
console.log(lines.join("\n"));
