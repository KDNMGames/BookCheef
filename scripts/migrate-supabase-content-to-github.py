#!/usr/bin/env python3
"""Copy public BookCheef content and Storage objects into a GitHub Release.

COPY ONLY: this script never deletes or mutates Supabase source data.
"""
from __future__ import annotations
import hashlib, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

TAG = os.environ.get("CONTENT_RELEASE_TAG", "bookcheef-content-archive-2026-11-25")
REPO = os.environ.get("CONTENT_REPO", "KDNMGames/BookCheef_DataBase")
BUCKETS = ("book-files", "gallery", "book-audio")
PAGE_SIZE = 100
ROOT = Path(tempfile.mkdtemp(prefix="bookcheef-content-export-"))
MANIFEST = []

def env(name):
    value = os.environ.get(name, "").strip()
    if not value: raise SystemExit(f"Missing required Actions secret/environment: {name}")
    return value

BASE = env("SUPABASE_URL").rstrip("/")
KEY = env("SUPABASE_SECRET_KEY")

def request(url, method="GET", payload=None, binary=False):
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
    if data is not None: headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
                return body if binary else json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read(500).decode("utf-8", "replace")
            if e.code in (429,500,502,503,504) and attempt < 5:
                time.sleep(min(60, 2 ** (attempt + 1))); continue
            raise RuntimeError(f"Supabase HTTP {e.code}: {detail}") from e
        except (urllib.error.URLError, TimeoutError):
            if attempt == 5: raise
            time.sleep(min(60, 2 ** (attempt + 1)))
    raise RuntimeError("Retries exhausted")

def ensure_release():
    if subprocess.run(["gh","release","view",TAG,"--repo",REPO],capture_output=True).returncode:
        subprocess.run(["gh","release","create",TAG,"--repo",REPO,"--title","BookCheef content archive — 2026-11-25",
          "--notes","Copy-only export. Supabase originals are retained until cutover and integrity verification.",
          "--latest=false"],check=True)

def upload(path, asset):
    target = path.with_name(asset)
    if path != target: path.rename(target)
    subprocess.run(["gh","release","upload",TAG,str(target),"--repo",REPO,"--clobber"],check=True)
    target.unlink(missing_ok=True)

def export_json(endpoint, filename, select):
    url = f"{BASE}/rest/v1/{endpoint}?select={urllib.parse.quote(select,safe=',.*()')}"
    rows = request(url)
    out = ROOT / filename
    out.write_text(json.dumps(rows,ensure_ascii=False,separators=(",",":")),encoding="utf-8")
    raw = out.read_bytes()
    upload(out,filename)
    MANIFEST.append({"kind":"database-export","name":filename,"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest(),"rows":len(rows)})

def list_bucket(bucket,prefix=""):
    offset=0
    while True:
        url=f"{BASE}/storage/v1/object/list/{urllib.parse.quote(bucket)}"
        rows=request(url,"POST",{"prefix":prefix,"limit":PAGE_SIZE,"offset":offset,"sortBy":{"column":"name","order":"asc"}})
        if not rows: break
        for item in rows:
            name=str(item.get("name",""))
            if not name: continue
            full=f"{prefix}/{name}".strip("/")
            if item.get("id") is None and item.get("metadata") is None:
                yield from list_bucket(bucket,full)
            else: yield full
        if len(rows)<PAGE_SIZE: break
        offset+=len(rows)

def export_object(bucket,path):
    url=f"{BASE}/storage/v1/object/{urllib.parse.quote(bucket)}/{urllib.parse.quote(path,safe='/')}"
    raw=request(url,binary=True)
    digest=hashlib.sha256(raw).hexdigest()
    ext=Path(path).suffix[:16] or ".bin"
    asset=f"{bucket}--{digest[:16]}{ext}"
    local=ROOT/asset
    local.write_bytes(raw)
    upload(local,asset)
    MANIFEST.append({"kind":"storage-object","bucket":bucket,"path":path,"asset":asset,"bytes":len(raw),"sha256":digest})

def main():
    ensure_release()
    # Public content only. User accounts, profiles, reviews, personal analytics and secrets are excluded.
    export_json("books","bookcheef-books-catalog.json",
      "id,title,category,description,cover_url,buy_url,views,created_at,author,age,genre,series,is_free,price,book_content,book_file_url,book_file_name,book_file_type,interactive_content,is_interactive,reader_questions,book_file_path,publication_key")
    export_json("book_audio_chapters","bookcheef-audio-chapters-index.json",
      "id,book_id,chapter_index,chapter_title,storage_path,duration_seconds,voice_name,model,content_hash,status,created_at,updated_at")
    export_json("book_audio_settings","bookcheef-audio-settings.json",
      "book_id,voice_mode,narrator_voice,style_prompt,speaker_profiles,updated_at")
    for bucket in BUCKETS:
        print(f"Listing {bucket}",flush=True); count=0
        for path in list_bucket(bucket):
            export_object(bucket,path); count+=1
            if count%20==0: print(f"{bucket}: {count} files copied",flush=True)
        print(f"{bucket}: {count} files copied",flush=True)
    manifest=ROOT/"bookcheef-content-manifest.json"
    manifest.write_text(json.dumps({"tag":TAG,"created_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
      "source":"Supabase copy-only export","deletion_performed":False,"entries":MANIFEST,
      "totals":{"objects":sum(x["kind"]=="storage-object" for x in MANIFEST),"bytes":sum(x.get("bytes",0) for x in MANIFEST)}},
      ensure_ascii=False,indent=2),encoding="utf-8")
    upload(manifest,"bookcheef-content-manifest.json")
    print(f"Export complete: {len(MANIFEST)} entries. Supabase unchanged.",flush=True)

if __name__=="__main__":
    try: main()
    except Exception as e:
        print(f"CONTENT EXPORT FAILED: {type(e).__name__}: {e}",file=sys.stderr); sys.exit(1)
