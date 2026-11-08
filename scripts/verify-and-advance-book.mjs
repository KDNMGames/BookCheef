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
const contentForImages = String(book.book_content||"") + JSON.stringify(book.interactive_content||{});
const embeddedUrls = contentForImages.split(/[\s"'<>)}]+/).filter(value =>
  value.startsWith("https://wendffewxxmnaglfksfg.supabase.co/storage/v1/object/public/gallery/")
);
const urls = [...new Set([book.cover_url, ...payload.illustrations.map(x=>x.url), ...embeddedUrls].filter(Boolean))];
if (urls.length < payload.illustrations.length + 1) throw new Error("The published book is missing one or more image URLs.");
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
  const cycle=["interactive","ordinary","ordinary"];
  const current=Math.max(1,Math.min(cycle.length,Number(state.cycle_position)||1));
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
console.log("Verified Supabase row, "+urls.length+" public images, and resolved reader content.");
