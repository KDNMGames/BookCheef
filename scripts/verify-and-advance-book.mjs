import fs from "node:fs/promises";

const payload = JSON.parse(await fs.readFile("publication-payload.json","utf8"));
const publishResult = JSON.parse(await fs.readFile("response.json","utf8"));
if (!publishResult.ok) throw new Error("Publisher did not confirm success.");
const endpoint = process.env.PUBLISHER_URL;
const token = process.env.PUBLISHER_TOKEN;
if (!endpoint || !token) throw new Error("Publisher verification credentials are missing.");

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type":"application/json", "x-book-publisher-token":token },
  body: JSON.stringify({ action:"check_publication", publication_key:payload.publication_key, include_content:true })
});
const result = await response.json().catch(()=>({}));
if (!response.ok || !result.ok || !result.published || !result.book) {
  throw new Error("The publication row could not be verified in Supabase.");
}
const book = result.book;
const contentForImages = String(book.book_content||"") + " " + JSON.stringify(book.interactive_content||{});
const galleryPrefix = "https://wendffewxxmnaglfksfg.supabase.co/storage/v1/object/public/gallery/";
const embeddedUrls = [...contentForImages.matchAll(/https:\/\/wendffewxxmnaglfksfg\.supabase\.co\/storage\/v1\/object\/public\/gallery\/[^\\s"'<>)}]+/g)]
  .map(match => match[0].replace(/[.,;!?]+$/,""));
const packageUrls = (payload.illustrations||[]).map(item=>item.url).filter(Boolean);
const urls = [...new Set([book.cover_url, ...packageUrls, ...embeddedUrls].filter(Boolean))];
const expectedIllustrations = (payload.illustrations||[]).length;
console.log("Image verification: cover=" + Boolean(book.cover_url) +
  ", embedded=" + embeddedUrls.length +
  ", package URLs=" + packageUrls.length +
  ", expected illustrations=" + expectedIllustrations +
  ", unique total=" + urls.length);
if (!book.cover_url) throw new Error("The published book has no cover URL.");
if (embeddedUrls.length < expectedIllustrations && packageUrls.length < expectedIllustrations) {
  throw new Error("The published book is missing one or more illustration URLs.");
}
if (urls.length < expectedIllustrations + 1) throw new Error("The published book is missing one or more image URLs.");
for (const url of urls) {
  const parsed = new URL(url);
  if (parsed.hostname !== "wendffewxxmnaglfksfg.supabase.co" || !parsed.pathname.startsWith("/storage/v1/object/public/gallery/")) {
    throw new Error("A published image URL points outside the public BookCheef gallery.");
  }
  const check = await fetch(url,{method:"HEAD"});
  if (!check.ok) throw new Error("A published image is not publicly accessible: HTTP "+check.status);
}
const combined = String(book.book_content||"") + JSON.stringify(book.interactive_content||{});
if (combined.includes("{{illustration:")) throw new Error("Unresolved illustration marker remains in the published reader content.");
if (String(book.publication_key) !== String(payload.publication_key)) throw new Error("The verified publication key does not match the package.");

const statePath="book-publications/rotation-state.json";
const state=JSON.parse(await fs.readFile(statePath,"utf8"));
if (state.last_publication?.publication_key !== payload.publication_key) {
  const config=JSON.parse(await fs.readFile("book-publications/automation-config.json","utf8"));
  const cycle=config.daily_book.rotation;
  if (!Array.isArray(cycle) || cycle.length < 1) throw new Error("Daily rotation configuration is invalid.");
  const current=Math.max(1,Math.min(cycle.length,Number(state.cycle_position)||1));
  const expectedType=cycle[(current-1)%cycle.length];
  const actualType=payload.is_interactive===true?"interactive":"ordinary";
  if (expectedType!==actualType) throw new Error("Published book type does not match the configured rotation slot.");
  state.cycle_position=(current % cycle.length)+1;
  state.published_count=(Number(state.published_count)||0)+1;
  state.updated_at=new Date().toISOString();
  state.last_publication={
    title:payload.title,
    author:payload.author,
    age:payload.age,
    type:payload.is_interactive===true?"interactive":"ordinary",
    publication_key:payload.publication_key
  };
  await fs.writeFile(statePath,JSON.stringify(state,null,2)+"\n");
  console.log("Rotation state advanced to position "+state.cycle_position+".");
} else {
  console.log("Rotation state already records this publication; no duplicate increment.");
}
const queuePath="book-publications/pending-publications.json";
const queue=JSON.parse(await fs.readFile(queuePath,"utf8"));
const before=Array.isArray(queue.packages)?queue.packages.length:0;
queue.packages=(Array.isArray(queue.packages)?queue.packages:[]).filter(item=>item.publication_key!==payload.publication_key);
if(queue.packages.length!==before){queue.updated_at=new Date().toISOString();await fs.writeFile(queuePath,JSON.stringify(queue,null,2)+"\n");}
console.log("Verified Supabase row, "+urls.length+" public images, resolved reader content, and cleared this item from the retry queue.");
