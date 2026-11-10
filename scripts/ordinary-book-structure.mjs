export function normalizeOrdinaryBookStructure(pkg) {
  if (!pkg || typeof pkg.book_content !== "string") return pkg;

  // Accept both Markdown headings and plain Russian chapter labels returned by models.
  pkg.book_content = pkg.book_content.replace(
    /^(Глава\s+\d+\s*[:.)—–-]\s*.+)$/gmi,
    "## $1"
  );

  // Discard model-generated markers that do not have matching illustration definitions.
  pkg.book_content = pkg.book_content
    .replace(/\{\{illustration:[^}]+\}\}/g, "")
    .replace(/\n{3,}/g, "\n\n");

  const headings = [...pkg.book_content.matchAll(/^##\s+(.+)$/gm)].map(match => ({
    title: match[1].trim()
  }));
  if (!headings.length || !Array.isArray(pkg.illustrations)) return pkg;

  const norm = value => String(value || "").normalize("NFKC").toLocaleLowerCase("ru")
    .replace(/^глава\s+\d+[. :\s-]*/i, "")
    .replace(/[«»“”"'’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

  for (let i = 0; i < pkg.illustrations.length; i++) {
    const item = pkg.illustrations[i];
    if (!item) continue;
    const wanted = norm(item.chapter);
    let heading = headings.find(h => norm(h.title) === wanted) ||
      headings.find(h => norm(h.title).includes(wanted) || wanted.includes(norm(h.title)));
    if (!heading) heading = headings[Math.min(i, headings.length - 1)];

    item.number = i + 1;
    item.chapter = heading.title;
    const marker = "{{illustration:" + item.chapter + ":" + item.number + "}}";
    const headingLine = "## " + heading.title;
    const insertAt = pkg.book_content.indexOf(headingLine) + headingLine.length;
    pkg.book_content = pkg.book_content.slice(0, insertAt) + "\n\n" + marker + "\n\n" +
      pkg.book_content.slice(insertAt);
  }

  return pkg;
}
