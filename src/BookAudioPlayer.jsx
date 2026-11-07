import React,{useEffect,useMemo,useRef,useState} from 'react';
import {supabase} from './supabase';
import {Headphones,RefreshCw,LoaderCircle,Volume2,CheckCircle2} from 'lucide-react';

function parseChapters(markdown,title){
  const source=String(markdown||'').replace(/\r\n?/g,'\n').trim();
  const headings=[...source.matchAll(/^##\s+(.+)$/gm)];
  if(!headings.length){
    const text=source.replace(/^#\s+[^\n]+\n*/,'').trim();
    return text?[{title:title||'Полная книга',text}]:[];
  }
  const result=[];
  const first=headings[0].index??0;
  const intro=source.slice(0,first).replace(/^#\s+[^\n]+\n*/,'').trim();
  if(intro.length>80)result.push({title:'Вступление',text:intro});
  headings.forEach((heading,i)=>{
    const start=(heading.index??0)+heading[0].length;
    const end=i+1<headings.length?(headings[i+1].index??source.length):source.length;
    const text=source.slice(start,end).trim();
    if(text)result.push({title:heading[1].trim(),text});
  });
  return result;
}
function durationLabel(value){
  const seconds=Math.max(0,Math.round(Number(value)||0));
  return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
}

export default function BookAudioPlayer({book,allowGeneration=false}){
  const chapters=useMemo(()=>parseChapters(book?.book_content,book?.title),[book?.book_content,book?.title]);
  const [audioChapters,setAudioChapters]=useState([]);
  const [selectedIndex,setSelectedIndex]=useState(null);
  const [audioUrl,setAudioUrl]=useState('');
  const [loading,setLoading]=useState(true);
  const [urlLoading,setUrlLoading]=useState(false);
  const [generating,setGenerating]=useState(false);
  const [progress,setProgress]=useState({done:0,total:0,title:''});
  const [error,setError]=useState('');
  const [playingAll,setPlayingAll]=useState(false);
  const audioRef=useRef(null);

  async function reload(){
    if(!supabase||!book?.id){setAudioChapters([]);setLoading(false);return;}
    setLoading(true);
    const {data,error:loadError}=await supabase.from('book_audio_chapters')
      .select('id,chapter_index,chapter_title,storage_path,duration_seconds,voice_name,model,content_hash')
      .eq('book_id',book.id).order('chapter_index');
    if(loadError){setError('Не удалось загрузить аудиоверсии.');setAudioChapters([]);}
    else{
      const rows=data||[];
      setAudioChapters(rows);
      setSelectedIndex(previous=>rows.some(x=>x.chapter_index===previous)?previous:(rows[0]?.chapter_index??null));
    }
    setLoading(false);
  }

  useEffect(()=>{setError('');setAudioUrl('');setSelectedIndex(null);setPlayingAll(false);reload();},[book?.id]);

  useEffect(()=>{
    let active=true;
    async function resolveUrl(){
      const item=audioChapters.find(x=>x.chapter_index===selectedIndex);
      if(!item||!supabase){setAudioUrl('');return;}
      setUrlLoading(true);
      const {data,error:urlError}=await supabase.storage.from('book-audio').createSignedUrl(item.storage_path,3600);
      if(active){
        setAudioUrl(urlError?'':data?.signedUrl||'');
        if(urlError)setError('Не удалось открыть аудиофайл. Проверь доступ к книге.');
        setUrlLoading(false);
      }
    }
    resolveUrl();
    return()=>{active=false;};
  },[audioChapters,selectedIndex]);

  useEffect(()=>{
    if(!playingAll||!audioUrl||!audioRef.current)return;
    audioRef.current.play().catch(()=>setPlayingAll(false));
  },[playingAll,audioUrl]);

  function playWholeBook(){
    if(!audioChapters.length)return;
    setError('');
    setPlayingAll(true);
    setSelectedIndex(audioChapters[0].chapter_index);
  }

  function handleTrackEnded(){
    if(!playingAll)return;
    const currentPosition=audioChapters.findIndex(item=>item.chapter_index===selectedIndex);
    const next=audioChapters[currentPosition+1];
    if(next)setSelectedIndex(next.chapter_index);
    else setPlayingAll(false);
  }

  async function generateAll(){
    if(!supabase||!allowGeneration||generating)return;
    setGenerating(true);setError('');
    const total=chapters.length;
    setProgress({done:0,total,title:''});
    try{
      for(let i=0;i<chapters.length;i++){
        setProgress({done:i,total,title:chapters[i].title});
        const {data,error:invokeError}=await supabase.functions.invoke('book-audio',{
          body:{book_id:book.id,chapter_index:i+1}
        });
        if(invokeError)throw new Error(invokeError.message||'Ошибка вызова генератора');
        if(data?.error)throw new Error(data.error);
        await reload();
        setProgress({done:i+1,total,title:chapters[i].title});
      }
      await reload();
    }catch(e){
      setError(e?.message||'Не удалось создать аудиокнигу. Можно продолжить после устранения ошибки.');
    }finally{setGenerating(false);}
  }

  const readyCount=audioChapters.length;
  const selected=audioChapters.find(x=>x.chapter_index===selectedIndex);
  if(!readyCount&&!allowGeneration)return null;
  if(!chapters.length&&!readyCount)return null;

  return <section className="book-audio-panel book-audio-compact" aria-label="Аудиокнига">
    {readyCount>0?<div className="book-audio-controls">
      <label className="book-audio-select-label" aria-label="Выбрать главу">
        <select value={selectedIndex??''} onChange={e=>{setPlayingAll(false);setSelectedIndex(Number(e.target.value));}}>
          {audioChapters.map(item=><option key={item.id} value={item.chapter_index}>{item.chapter_index}. {item.chapter_title}</option>)}
        </select>
      </label>
      <button type="button" className="ghost book-audio-play-all" onClick={playingAll?()=>{setPlayingAll(false);audioRef.current?.pause();}:playWholeBook} disabled={!audioChapters.length||urlLoading}>
        {playingAll?'Стоп':'Вся книга'}
      </button>
      {urlLoading?<span className="book-audio-loading"><LoaderCircle size={16}/></span>:audioUrl?<audio ref={audioRef} controls preload="metadata" src={audioUrl} onEnded={handleTrackEnded} className="book-audio-element">Ваш браузер не поддерживает аудиоплеер.</audio>:null}
    </div>:null}
    {allowGeneration&&chapters.length>0?<div className="book-audio-admin">
      <button type="button" className="primary" onClick={generateAll} disabled={generating}>
        {generating?<><LoaderCircle size={16} className="spin"/> Озвучиваем {progress.done}/{progress.total}</>:<><RefreshCw size={16}/> {readyCount?'Продолжить озвучку':'Создать аудиокнигу'}</>}
      </button>
      {generating?<div className="book-audio-progress"><div style={{width:(progress.total?progress.done/progress.total*100:0)+'%'}}/><span>{progress.title||'Подготовка…'}</span></div>:null}
    </div>:null}
    {error?<p className="book-audio-error" role="alert">{error}</p>:null}
  </section>;
}
