import json
from pathlib import Path
base = Path('/home/runner/work/BookCheef/BookCheef/book-publications/workers/interactive/outbox')
draft = json.loads((base/'draft-izolator-tretey-vakhty.json').read_text())
scenes = {k:(base/'scenes'/f).read_text().strip() for k,f in [('scene-1','scene-1.txt'),('scene-2a','scene-2a.txt'),('scene-2b','scene-2b.txt'),('ending-a','ending-a.txt'),('ending-b','ending-b.txt')]}
for n in draft['interactive_content']['nodes']:
    n['text']=scenes[n['id']]
(base/'izolator-tretey-vakhty.json').write_text(json.dumps(draft,ensure_ascii=False,indent=2),encoding='utf-8')
for n in draft['interactive_content']['nodes']:
    print(n['id'], len(n['text'].split()))
