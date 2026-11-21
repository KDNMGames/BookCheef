import React,{useCallback,useEffect,useState} from 'react';
import {supabase} from './supabase';
import {Activity,BookOpen,Eye,Heart,MessageSquare,RefreshCw,Users,UserRound,Bot,ThumbsUp,ThumbsDown} from 'lucide-react';

const number=value=>Number(value||0).toLocaleString('ru-RU');
function Metric({icon:Icon,label,value}){return <div className="book-analytics-metric"><Icon size={15}/><span>{label}</span><b>{number(value)}</b></div>;}

export default function BookAnalytics(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const reload=useCallback(async()=>{
    setLoading(true);setError('');
    const {data,error:requestError}=await supabase.rpc('get_book_analytics');
    if(requestError){setError(requestError.message||'Не удалось загрузить аналитику.');setRows([]);}
    else setRows(data||[]);
    setLoading(false);
  },[]);
  useEffect(()=>{reload();},[reload]);
  return <section className="panel book-analytics-panel">
    <div className="panel-title"><div><h2>Аналитика по книгам</h2><p className="panel-hint">Отдельная статистика посетителей и автоматических участников</p></div><button type="button" className="ghost book-analytics-refresh" onClick={reload} disabled={loading}><RefreshCw size={15} className={loading?'spin':''}/> Обновить</button></div>
    <div className="book-analytics-legend"><span><UserRound size={14}/> Реальные посетители</span><span><Bot size={14}/> Автоучастники BookCheef</span></div>
    {error?<div className="error" role="alert">{error}</div>:loading?<p className="muted">Загружаем статистику…</p>:!rows.length?<p className="muted">Книг пока нет.</p>:<div className="book-analytics-list">{rows.map(row=><article className="book-analytics-card" key={row.book_id}>
      <div className="book-analytics-book-head"><h3>{row.title}</h3><span><Eye size={15}/> {number(row.total_views)} просмотров всего</span></div>
      <div className="book-analytics-columns">
        <section className="book-analytics-human"><h4><Users size={16}/> Люди</h4>
          <div className="book-analytics-grid">
            <Metric icon={Activity} label="Уникальные посетители*" value={row.tracked_unique_visitors}/>
            <Metric icon={UserRound} label="С аккаунтом" value={row.registered_visitors}/>
            <Metric icon={Eye} label="Без аккаунта" value={row.anonymous_visitors}/>
            <Metric icon={BookOpen} label="Начали читать" value={row.started_readers}/>
            <Metric icon={BookOpen} label="Прочитали" value={row.completed_readers}/>
            <Metric icon={MessageSquare} label="Отзывы" value={row.human_reviews}/>
            <Metric icon={MessageSquare} label="Ответы" value={row.human_replies}/>
            <Metric icon={ThumbsUp} label="Нравится" value={row.human_likes}/>
            <Metric icon={ThumbsDown} label="Не нравится" value={row.human_dislikes}/>
          </div>
        </section>
        <section className="book-analytics-bots"><h4><Bot size={16}/> Автоучастники</h4>
          <div className="book-analytics-grid">
            <Metric icon={MessageSquare} label="Автоотзывы" value={row.bot_reviews}/>
            <Metric icon={MessageSquare} label="Автоответы" value={row.bot_replies}/>
          </div>
          <p>Учитываются только записи, созданные автоматическими профилями BookCheef. Боты не засчитываются как посетители или читатели.</p>
        </section>
      </div>
    </article>)}</div>}
    <small className="book-analytics-footnote">* Уникальные посетители учитываются с момента включения аналитики; просмотры всего включают ранее накопленный счётчик. Анонимные посещения считаются по браузеру и не подтверждают личность человека.</small>
  </section>;
}
