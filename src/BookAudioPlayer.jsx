import React,{useEffect,useMemo,useRef,useState} from 'react';
import {supabase} from './supabase';
import {Headphones,RefreshCw,LoaderCircle,Volume2,CheckCircle2} from 'lucide-react';

function parseChapters(markdown,title,interactiveContent){
  const nodes=Array.isArray(interactiveContent?.nodes)?interactiveContent.nodes:[];
  if(nodes.length){
    return nodes.map((node,index)=>{
      const choices=Array.isArray(node.choices)?node.choices.map(choice=>choice?.label).filter(Boolean):[];
      const text=[String(node.text||'').trim(),choices.length?'Варианты выбора: '+choices.join('. ')+'.':''].filter(Boolean).join('\n\n');
      return {title:String(node.title||`Сцена ${index+1}`),text};
    }).filter(chapter=>chapter.text);
  }
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
  const chapters=useMemo(()=>parseChapters(book?.book_content,book?.title,book?.interactive_content),[book?.book_content,book?.title,book?.interactive_content]);
  const [audioChapters,setAudioChapters]=useState([]);
  const [selectedIndex,setSelectedIndex]=useState(null);
  const [audioUrl,setAudioUrl]=useState('');
  const [loading,setLoading]=useState(true);
  const [urlLoading,setUrlLoading]=useState(false);
  const [generating,setGenerating]=useState(false);
  const [progress,setProgress]=useState({done:0,total:0,title:''});
  const [error,setError]=useState('');
  const [playingAll,setPlayingAll]=useState(false);
  const [voiceSettings,setVoiceSettings]=useState({voice_mode:'auto_multi',narrator_voice:'Charon',style_prompt:''});
  const [voiceSettingsLoading,setVoiceSettingsLoading]=useState(false);
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
    if(!allowGeneration||!supabase||!book?.id)return;
    let active=true;
    setVoiceSettingsLoading(true);
    supabase.from('book_audio_settings')
      .select('voice_mode,narrator_voice,style_prompt')
      .eq('book_id',book.id).maybeSingle()
      .then(({data,error:settingsError})=>{
        if(!active)return;
        if(settingsError){
          setError('Не удалось загрузить настройки голосов. Проверь миграцию многоголосой озвучки.');
        }else if(data){
          setVoiceSettings({
            voice_mode:data.voice_mode==='single'?'single':'auto_multi',
            narrator_voice:data.narrator_voice||'Charon',
            style_prompt:data.style_prompt||''
          });
        }else{
          setVoiceSettings({voice_mode:'auto_multi',narrator_voice:'Charon',style_prompt:''});
        }
        setVoiceSettingsLoading(false);
      });
    return()=>{active=false;};
  },[book?.id,allowGeneration]);


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
    // Обычная аудиокнига автоматически переходит к следующей готовой главе,
    // даже если читатель запустил текущую главу отдельно.
    // Для интерактивных книг сохраняем прежнее поведение: переход только
    // в режиме «Вся книга», без вмешательства в выбор сюжетных сцен.
    if(book?.is_interactive&&!playingAll)return;
    const currentPosition=audioChapters.findIndex(item=>item.chapter_index===selectedIndex);
    const next=audioChapters[currentPosition+1];
    if(next){
      setPlayingAll(true);
      setSelectedIndex(next.chapter_index);
    }else setPlayingAll(false);
  }

  async function generateAll(){
    if(!supabase||!allowGeneration||generating)return;
    setGenerating(true);setError('');
    const total=chapters.length;
    setProgress({done:0,total,title:''});
    try{
      const {error:settingsError}=await supabase.from('book_audio_settings').upsert({
        book_id:book.id,
        voice_mode:voiceSettings.voice_mode,
        narrator_voice:voiceSettings.narrator_voice,
        style_prompt:voiceSettings.style_prompt.trim().slice(0,500),
        updated_at:new Date().toISOString()
      },{onConflict:'book_id'});
      if(settingsError)throw new Error('Не удалось сохранить настройки голосов: '+settingsError.message);
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
      {selected?.voice_name?<small className="book-audio-voice-cast">Голоса главы: {selected.voice_name}</small>:null}
    </div>:null}
    {allowGeneration&&chapters.length>0?<div className="book-audio-admin">
      <div className="book-audio-voice-settings">
        <h3>Голоса аудиокниги</h3>
        <label>Режим озвучки
          <select value={voiceSettings.voice_mode} disabled={generating||voiceSettingsLoading} onChange={e=>setVoiceSettings(v=>({...v,voice_mode:e.target.value}))}>
            <option value="auto_multi">Многоголосая — ИИ распределяет роли</option>
            <option value="single">Один голос на всю книгу</option>
          </select>
        </label>
        <label>Голос рассказчика
          <select value={voiceSettings.narrator_voice} disabled={generating||voiceSettingsLoading} onChange={e=>setVoiceSettings(v=>({...v,narrator_voice:e.target.value}))}>
            <option value="Achernar">Achernar — мягкий</option>
            <option value="Achird">Achird — дружелюбный</option>
            <option value="Algenib">Algenib — слегка хрипловатый</option>
            <option value="Algieba">Algieba — бархатистый</option>
            <option value="Alnilam">Alnilam — уверенный</option>
            <option value="Aoede">Aoede — лёгкий</option>
            <option value="Autonoe">Autonoe — яркий</option>
            <option value="Callirrhoe">Callirrhoe — разговорный</option>
            <option value="Charon">Charon — информативный</option>
            <option value="Despina">Despina — плавный</option>
            <option value="Enceladus">Enceladus — мягкий, с придыханием</option>
            <option value="Erinome">Erinome — чёткий</option>
            <option value="Fenrir">Fenrir — энергичный</option>
            <option value="Gacrux">Gacrux — зрелый</option>
            <option value="Iapetus">Iapetus — ясный</option>
            <option value="Kore">Kore — собранный</option>
            <option value="Laomedeia">Laomedeia — бодрый</option>
            <option value="Leda">Leda — молодой по звучанию</option>
            <option value="Orus">Orus — твёрдый</option>
            <option value="Puck">Puck — живой</option>
            <option value="Pulcherrima">Pulcherrima — выразительный</option>
            <option value="Rasalgethi">Rasalgethi — выразительный дикторский</option>
            <option value="Sadachbia">Sadachbia — оживлённый</option>
            <option value="Sadaltager">Sadaltager — рассудительный</option>
            <option value="Schedar">Schedar — ровный</option>
            <option value="Sulafat">Sulafat — тёплый</option>
            <option value="Umbriel">Umbriel — непринуждённый</option>
            <option value="Vindemiatrix">Vindemiatrix — нежный</option>
            <option value="Zephyr">Zephyr — светлый</option>
            <option value="Zubenelgenubi">Zubenelgenubi — современный разговорный</option>
          </select>
        </label>
        <label>Дополнительное пожелание к озвучке
          <textarea rows="2" maxLength="500" value={voiceSettings.style_prompt} disabled={generating||voiceSettingsLoading} onChange={e=>setVoiceSettings(v=>({...v,style_prompt:e.target.value}))} placeholder="Например: спокойная сказочная подача, без резких эмоций…"/>
        </label>
        <small>{voiceSettings.voice_mode==='auto_multi'?'ИИ определит рассказчика и персонажей, сохранит их голоса на протяжении главы и подберёт тембр по жанру и характеру.':'Весь текст будет прочитан выбранным голосом.'} Используются только бесплатные модели Gemini; при исчерпании квоты генерация остановится и продолжится позже.</small>
      </div>
      <button type="button" className="primary" onClick={generateAll} disabled={generating||voiceSettingsLoading}>
        {generating?<><LoaderCircle size={16} className="spin"/> Озвучиваем {progress.done}/{progress.total}</>:<><RefreshCw size={16}/> {readyCount?'Продолжить озвучку':'Создать аудиокнигу'}</>}
      </button>
      {generating?<div className="book-audio-progress"><div style={{width:(progress.total?progress.done/progress.total*100:0)+'%'}}/><span>{progress.title||'Подготовка…'}</span></div>:null}
    </div>:null}
    {error?<p className="book-audio-error" role="alert">{error}</p>:null}
  </section>;
}
