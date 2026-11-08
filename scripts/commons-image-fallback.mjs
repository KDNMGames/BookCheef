const API = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "BookCheefBookPublisher/1.0 (https://github.com/KDNMGames/BookCheef)";
const MAX_BYTES = 10 * 1024 * 1024;

function plain(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function licenseIsSafe(meta) {
  const name = plain(meta.LicenseShortName?.value || "");
  const usage = plain(meta.UsageTerms?.value || "");
  const licenseUrl = String(meta.LicenseUrl?.value || "");
  const allowed = /^(public domain|public domain mark|pdm|cc0|cc0 1\.0(?: universal)?)$/i;
  const noAttribution = /^(false|0|no)$/i.test(plain(meta.AttributionRequired?.value || ""));
  const publicDomain = /^(false|0|no)$/i.test(plain(meta.Copyrighted?.value || ""));
  const nonFree = /^(true|1|yes)$/i.test(plain(meta.NonFree?.value || ""));
  const restrictions = plain(meta.Restrictions?.value || "");
  const cc0Url = /creativecommons\.org\/publicdomain\/zero\/1\.0/i.test(licenseUrl);
  return (allowed.test(name) || allowed.test(usage) || cc0Url) &&
    noAttribution &&
    (publicDomain || /^cc0(?: 1\.0(?: universal)?)?$/i.test(name) || cc0Url) &&
    !nonFree && !restrictions;
}

function makeQueries(prompt) {
  const cleaned = String(prompt || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/cinematic|painterly|digital realism|finely etched|highly detailed|atmospheric|directional lighting|consistent material textures|illustration|artwork|style|palette|lighting|wide shot|close-up|realistic/gi, " ")
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ -]/g, " ")
    .replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(w => w.length > 2);
  return [...new Set([
    words.slice(0, 14).join(" "),
    words.slice(0, 8).join(" "),
    words.slice(0, 5).join(" "),
    words.slice(-8).join(" ")
  ])].filter(q => q.length >= 8);
}

export async function findCommonsImage(task, usedFiles = new Set()) {
  for (const query of makeQueries(task.prompt)) {
    const params = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: query,
      gsrnamespace: "6",
      gsrlimit: "40",
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      format: "json",
      formatversion: "2"
    });
    const response = await fetch(API + "?" + params, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) throw new Error("Wikimedia Commons search HTTP " + response.status);
    const data = await response.json();
    for (const page of data?.query?.pages || []) {
      const info = page.imageinfo?.[0];
      const meta = info?.extmetadata || {};
      if (!info?.url || usedFiles.has(page.title) || !licenseIsSafe(meta)) continue;
      if (!["image/jpeg", "image/png", "image/webp"].includes(info.mime)) continue;
      if (Number(info.width || 0) < 512 || Number(info.height || 0) < 512) continue;
      if (Number(info.size || 0) < 20000 || Number(info.size || 0) > MAX_BYTES) continue;

      const description = plain(meta.ImageDescription?.value || "");
      const titleAndDescription = (page.title + " " + description).toLowerCase();
      if (/\b(logo|trademark|brand logo|watermark|screenshot|poster|advertisement)\b/i.test(titleAndDescription)) continue;

      const fileResponse = await fetch(info.url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(60000)
      });
      if (!fileResponse.ok) continue;
      const mime = (fileResponse.headers.get("content-type") || "").split(";")[0].toLowerCase();
      if (mime !== info.mime) continue;
      const bytes = Buffer.from(await fileResponse.arrayBuffer());
      if (bytes.length < 20000 || bytes.length > MAX_BYTES) continue;

      usedFiles.add(page.title);
      return {
        mime_type: mime,
        base64: bytes.toString("base64"),
        source: {
          provider: "Wikimedia Commons",
          file_title: page.title,
          file_page_url: info.descriptionurl || "https://commons.wikimedia.org/wiki/" + encodeURIComponent(page.title.replace(/ /g, "_")),
          license_name: plain(meta.LicenseShortName?.value || meta.UsageTerms?.value || "CC0 / Public Domain"),
          license_url: meta.LicenseUrl?.value || "",
          attribution_required: false,
          commercial_use: true,
          verified_at: new Date().toISOString()
        }
      };
    }
  }
  throw new Error("No matching Wikimedia Commons image with machine-verified CC0/Public Domain and no attribution requirement for " + task.label);
}

export async function findCommonsImageSet(tasks) {
  const usedFiles = new Set();
  const images = [];
  for (let i = 0; i < tasks.length; i++) {
    console.log("Searching Wikimedia Commons for a verified no-attribution image: " + tasks[i].label);
    images.push(await findCommonsImage(tasks[i], usedFiles));
    if (i < tasks.length - 1) await new Promise(resolve => setTimeout(resolve, 1200));
  }
  return images;
}
