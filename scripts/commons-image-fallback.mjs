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

async function findOpenverseImage(task, usedFiles) {
  const queries = makeQueries(task.prompt);
  for (const query of queries) {
    const params = new URLSearchParams({
      q: query.slice(0, 200),
      license: "cc0",
      license_type: "commercial",
      size: "large",
      extension: "jpg,png,webp",
      filter_dead: "true",
      mature: "false",
      page_size: "20"
    });
    const response = await fetch("https://api.openverse.org/v1/images/?" + params, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) throw new Error("Openverse search HTTP " + response.status);
    const data = await response.json();
    for (const item of data?.results || []) {
      if (!item?.id || usedFiles.has(item.id) || item.license !== "cc0") continue;
      if (!/^https:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/i.test(item.license_url || "")) continue;
      if (item.mature === true || Number(item.width || 0) < 512 || Number(item.height || 0) < 512) continue;
      const descriptiveText = [item.title || "", ...(item.tags || []).map(tag => tag?.name || tag || "")].join(" ");
      if (/\\b(logo|trademark|brand|celebrity|portrait|headshot|selfie|model|person|people|man|woman|child|children|painting|sculpture|poster)\\b/i.test(descriptiveText)) continue;
      if (!item.url || Number(item.filesize || 0) > MAX_BYTES || Number(item.filesize || 0) < 20000) continue;
      const ext = String(item.filetype || "").toLowerCase();
      const expectedMime = ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" })[ext];
      if (!expectedMime) continue;

      // Re-fetch the individual record so a search-index result alone is not treated as proof.
      if (!item.detail_url) continue;
      const detailResponse = await fetch(item.detail_url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(30000)
      });
      if (!detailResponse.ok) continue;
      const detail = await detailResponse.json();
      if (detail.license !== "cc0" ||
          !/^https:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/i.test(detail.license_url || "")) continue;

      const fileResponse = await fetch(item.url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(60000)
      });
      if (!fileResponse.ok) continue;
      const actualMime = (fileResponse.headers.get("content-type") || "").split(";")[0].toLowerCase();
      if (actualMime && actualMime !== "application/octet-stream" && actualMime !== expectedMime) continue;
      const bytes = Buffer.from(await fileResponse.arrayBuffer());
      if (bytes.length < 20000 || bytes.length > MAX_BYTES) continue;
      const validBytes =
        (expectedMime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
        (expectedMime === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
        (expectedMime === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
      if (!validBytes) continue;

      usedFiles.add(item.id);
      return {
        mime_type: expectedMime,
        base64: bytes.toString("base64"),
        source: {
          provider: "Openverse",
          source_provider: item.source || detail.source || "",
          file_title: item.title || detail.title || "",
          file_page_url: item.foreign_landing_url || detail.foreign_landing_url || item.detail_url,
          license_name: "CC0 1.0",
          license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
          attribution_required: false,
          commercial_use: true,
          verified_at: new Date().toISOString()
        }
      };
    }
  }
  throw new Error("No matching Openverse CC0 commercial-use image for " + task.label);
}

async function findCommonsPublicDomainImage(task, usedFiles = new Set()) {
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

export async function findCommonsImage(task, usedFiles = new Set()) {
  try {
    const image = await findOpenverseImage(task, usedFiles);
    console.log("Found CC0 commercial-use image through Openverse for " + task.label);
    return image;
  } catch (openverseError) {
    console.log("Openverse had no verified match for " + task.label + ": " + openverseError.message);
    const image = await findCommonsPublicDomainImage(task, usedFiles);
    console.log("Found verified public-domain image through Wikimedia Commons for " + task.label);
    return image;
  }
}

export async function findCommonsImageSet(tasks) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const openverseFiles = new Set();
  try {
    const images = [];
    for (let i = 0; i < tasks.length; i++) {
      console.log("Searching Openverse CC0 for " + tasks[i].label + " (" + (i + 1) + "/" + tasks.length + ")");
      images.push(await findOpenverseImage(tasks[i], openverseFiles));
      if (i < tasks.length - 1) await wait(1500);
    }
    return images;
  } catch (error) {
    console.log("Openverse could not supply the complete image set; discarding that partial set and restarting with Wikimedia Commons: " + error.message);
  }

  const commonsFiles = new Set();
  const images = [];
  for (let i = 0; i < tasks.length; i++) {
    console.log("Searching Wikimedia Commons Public Domain for " + tasks[i].label + " (" + (i + 1) + "/" + tasks.length + ")");
    images.push(await findCommonsPublicDomainImage(tasks[i], commonsFiles));
    if (i < tasks.length - 1) await wait(1500);
  }
  return images;
}
