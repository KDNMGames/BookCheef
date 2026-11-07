import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const site = "https://kdnmgames.github.io/BookCheef/";
const channel = "https://t.me/BookCheef";
const campaign = process.env.BOOKCHEEF_CAMPAIGN || "launch-2026-11";
const generatedAt = new Date().toISOString();

function siteLink(source, medium = "community") {
  const url = new URL(site);
  url.searchParams.set("utm_source", source);
  url.searchParams.set("utm_medium", medium);
  url.searchParams.set("utm_campaign", campaign);
  return url.toString();
}

const assets = [
  {
    id: "intro",
    title: "Знакомство с BookCheef",
    text: `📚 BookCheef — книжная галерея для тех, кто любит читать и открывать новые истории.

Здесь собраны книги разных жанров, бесплатные произведения и интерактивные истории, в которых решения читателя влияют на развитие сюжета.

Загляните в каталог и выберите историю по душе:
${siteLink("community_intro")}

Новости проекта и новые публикации:
${channel}`,
  },
  {
    id: "free-books",
    title: "Бесплатные книги",
    text: `📖 Ищете, что почитать бесплатно?

В BookCheef можно познакомиться с каталогом книг и открыть доступные для бесплатного чтения истории. Есть разные жанры и произведения для разных возрастов.

Открыть книжную галерею:
${siteLink("community_free_books")}

В Telegram рассказываем о новых книгах:
${channel}`,
  },
  {
    id: "interactive-books",
    title: "Интерактивные книги",
    text: `🎮 А что, если книга будет реагировать на ваши решения?

В BookCheef есть интерактивные истории: выборы помогают менять ход событий и приводят к разным вариантам развития сюжета.

Попробовать:
${siteLink("community_interactive")}

Подписаться на книжные новости:
${channel}`,
  },
  {
    id: "weekly-new-books",
    title: "Новые книги",
    text: `✨ В BookCheef появляются новые истории и книжные проекты.

В каталоге можно посмотреть свежие поступления, познакомиться с описаниями и перейти непосредственно к заинтересовавшей книге.

Посмотреть новинки:
${siteLink("community_new_books")}

Анонсы новых публикаций — в Telegram:
${channel}`,
  },
];

const outDir = path.join(root, "marketing", "generated");
fs.mkdirSync(outDir, { recursive: true });
const markdown = [
  "# BookCheef — стартовый набор рекламных публикаций",
  "",
  `Сформировано: ${generatedAt}`,
  `Кампания: ${campaign}`,
  "",
  "> Перед публикацией адаптируйте текст под формат площадки и проверьте её правила. Этот набор не является разрешением на автоматическую публикацию.",
  "",
  ...assets.flatMap(asset => [
    `## ${asset.title}`,
    "",
    asset.text,
    "",
    "---",
    "",
  ]),
].join("\n");
const output = path.join(outDir, "current-campaign.md");
fs.writeFileSync(output, markdown, "utf8");
console.log(`Created ${output} with ${assets.length} campaign assets.`);
