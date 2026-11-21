import React,{useCallback,useEffect,useState} from 'react';
import {supabase} from './supabase';
import {RefreshCw,UserRound,Bot} from 'lucide-react';

const number=value=>Number(value||0).toLocaleString('ru-RU');

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
    <div className="panel-title"><div><h2>Аналитика по книгам</h2><p className="panel-hint">Сводная таблица статистики отдельно по каждой книге</p></div><button type="button" className="ghost book-analytics-refresh" onClick={reload} disabled={loading}><RefreshCw size={15} className={loading?'spin':''}/> Обновить</button></div>
    <div className="book-analytics-legend"><span><UserRound size={14}/> Реальные посетители и читатели</span><span><Bot size={14}/> Автоматические отзывы и ответы</span></div>
    {error?<div className="error" role="alert">{error}</div>:loading?<p className="muted">Загружаем статистику…</p>:!rows.length?<p className="muted">Книг пока нет.</p>:<div className="book-analytics-table-wrap"><table className="book-analytics-table">
      <thead><tr><th rowSpan="2">Книга</th><th rowSpan="2">Просмотры всего</th><th colSpan="5">Люди</th><th colSpan="4">Отзывы людей</th><th colSpan="2">Боты</th></tr><tr><th>Уникальные посетители*</th><th>С аккаунтом</th><th>Без аккаунта</th><th>Начали читать</th><th>Прочитали</th><th>Отзывы</th><th>Ответы</th><th>Нравится</th><th>Не нравится</th><th>Автоотзывы</th><th>Автоответы</th></tr></thead>
      <tbody>{rows.map(row=><tr key={row.book_id}><th scope="row">{row.title}</th><td>{number(row.total_views)}</td><td>{number(row.tracked_unique_visitors)}</td><td>{number(row.registered_visitors)}</td><td>{number(row.anonymous_visitors)}</td><td>{number(row.started_readers)}</td><td>{number(row.completed_readers)}</td><td>{number(row.human_reviews)}</td><td>{number(row.human_replies)}</td><td>{number(row.human_likes)}</td><td>{number(row.human_dislikes)}</td><td>{number(row.bot_reviews)}</td><td>{number(row.bot_replies)}</td></tr>)}</tbody>
    </table></div>}
    <small className="book-analytics-footnote">* Уникальные посетители учитываются с момента включения аналитики; просмотры всего включают ранее накопленный счётчик. Анонимные посещения считаются по браузеру и не подтверждают личность человека. Боты не засчитываются как посетители или читатели.</small>
  </section>;
}
