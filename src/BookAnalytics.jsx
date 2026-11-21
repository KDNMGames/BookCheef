import React,{useCallback,useEffect,useMemo,useState} from 'react';
import {supabase} from './supabase';
import {RefreshCw,UserRound,Bot,Search,BookOpen,Users,Eye,MessageCircle,TrendingUp,CalendarDays} from 'lucide-react';

const number=value=>Number(value||0).toLocaleString('ru-RU');
const dateLabel=value=>value?new Date(value).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'2-digit'}):'—';

function SortHead({column,label,sort,onSort}) {
  const active=sort.key===column;
  return <th aria-sort={active?(sort.direction==='asc'?'ascending':'descending'):'none'}>
    <button type="button" className="analytics-sort" onClick={()=>onSort(column)}>{label}<span>{active?(sort.direction==='asc'?'↑':'↓'):'↕'}</span></button>
  </th>;
}

export default function BookAnalytics({books=[]}) {
  const [rows,setRows]=useState([]);
  const [dashboard,setDashboard]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [period,setPeriod]=useState('30');
  const [section,setSection]=useState('books');
  const [search,setSearch]=useState('');
  const [sort,setSort]=useState({key:'total_views',direction:'desc'});

  const reload=useCallback(async()=>{
    setLoading(true);setError('');
    const [bookResult,dashboardResult]=await Promise.all([
      supabase.rpc('get_book_analytics'),
      supabase.rpc('get_book_analytics_dashboard',{p_days:Number(period)})
    ]);
    if(bookResult.error||dashboardResult.error){
      setError(bookResult.error?.message||dashboardResult.error?.message||'Не удалось загрузить аналитику.');
    } else {
      setRows(bookResult.data||[]);
      setDashboard(dashboardResult.data||null);
    }
    setLoading(false);
  },[period]);
  useEffect(()=>{reload();},[reload]);

  const bookInfo=useMemo(()=>new Map(books.map(book=>[String(book.id),book])),[books]);
  const totals=dashboard?.totals||{};
  const categories=dashboard?.categories||[];
  const authors=dashboard?.authors||[];
  const terms=dashboard?.search_terms||[];
  const daily=dashboard?.search_daily||[];

  const columns=useMemo(()=>{
    if(section==='books')return [
      ['title','Книга','text'],['author','Автор','text'],['category','Категория','text'],
      ['total_views','Просмотры','number'],['tracked_unique_visitors','Уникальные посетители','number'],
      ['registered_visitors','С аккаунтом','number'],['anonymous_visitors','Без аккаунта','number'],
      ['started_readers','Начали читать','number'],['completed_readers','Прочитали','number'],
      ['human_reviews','Отзывы людей','number'],['human_replies','Ответы людей','number'],
      ['bot_reviews','Отзывы ботов','number'],['bot_replies','Ответы ботов','number'],
      ['human_likes','Полезно','number'],['human_dislikes','Не полезно','number']
    ];
    if(section==='categories')return [
      ['category','Категория','text'],['book_count','Книг','number'],['total_views','Просмотры','number'],
      ['unique_visitors','Уникальные посетители','number'],['started_readers','Начали читать','number'],['human_reviews','Отзывы','number']
    ];
    if(section==='authors')return [
      ['author','Автор','text'],['book_count','Книг','number'],['total_views','Просмотры','number'],
      ['unique_visitors','Уникальные посетители','number'],['started_readers','Начали читать','number'],['human_reviews','Отзывы','number']
    ];
    return [
      ['query','Поисковый запрос','text'],['search_count','Поисков','number'],['unique_visitors','Посетителей','number'],
      ['no_results','Без результатов','number'],['average_results','Среднее число книг','number'],['last_searched','Последний поиск','date']
    ];
  },[section]);

  const sourceRows=section==='books'
    ?rows.map(row=>({...row,author:bookInfo.get(String(row.book_id))?.author||'Автор не указан',category:bookInfo.get(String(row.book_id))?.category||'Без категории'}))
    :section==='categories'?categories:section==='authors'?authors:terms;
  const visibleRows=useMemo(()=>{
    const q=search.trim().toLocaleLowerCase('ru-RU');
    const filtered=sourceRows.filter(row=>!q||columns.some(([key,,type])=>String(type==='date'?dateLabel(row[key]):row[key]??'').toLocaleLowerCase('ru-RU').includes(q)));
    return filtered.sort((a,b)=>{
      const key=sort.key;let av=a[key]??'',bv=b[key]??'';
      if(key==='last_searched'){av=av?new Date(av).getTime():0;bv=bv?new Date(bv).getTime():0;}
      else if(typeof av==='number'||typeof bv==='number'||columns.find(c=>c[0]===key)?.[2]==='number'){av=Number(av)||0;bv=Number(bv)||0;}
      else {av=String(av).toLocaleLowerCase('ru-RU');bv=String(bv).toLocaleLowerCase('ru-RU');}
      const result=av<bv?-1:av>bv?1:0;
      return sort.direction==='asc'?result:-result;
    });
  },[sourceRows,search,columns,sort]);

  function changeSort(key){setSort(current=>current.key===key?{key,direction:current.direction==='asc'?'desc':'asc'}:{key,direction:['title','author','category','query'].includes(key)?'asc':'desc'});}
  function selectSection(next){setSection(next);setSearch('');setSort({key:next==='books'||next==='categories'||next==='authors'?'total_views':'search_count',direction:'desc'});}

  const metricCards=[
    {label:'Книг в каталоге',value:totals.books,icon:BookOpen},
    {label:'Просмотры книг',value:totals.views,icon:Eye},
    {label:'Уникальные посетители*',value:totals.unique_visitors,icon:Users},
    {label:'Начали читать',value:totals.started_readers,icon:BookOpen},
    {label:'Завершили чтение',value:totals.completed_readers,icon:BookOpen},
    {label:'Отзывы людей',value:totals.human_reviews,icon:MessageCircle},
    {label:'Отзывы ботов',value:totals.bot_reviews,icon:Bot},
    {label:'Поиски за период',value:totals.searches,icon:Search},
    {label:'Поиски без результата',value:totals.search_no_results,icon:TrendingUp}
  ];

  return <section className="panel book-analytics-panel">
    <div className="panel-title"><div><h2>Аналитика BookCheef</h2><p className="panel-hint">Книги, категории, авторы и поведение посетителей</p></div><button type="button" className="ghost book-analytics-refresh" onClick={reload} disabled={loading}><RefreshCw size={15} className={loading?'spin':''}/> Обновить</button></div>
    <div className="analytics-period"><CalendarDays size={15}/><label>Период поисковой аналитики <select value={period} onChange={e=>setPeriod(e.target.value)}><option value="7">7 дней</option><option value="30">30 дней</option><option value="90">90 дней</option><option value="0">За всё время</option></select></label><small>Статистика книг, категорий и авторов — накопительная.</small></div>
    {error&&<div className="error" role="alert">{error}</div>}
    {loading&&!dashboard?<p className="muted">Загружаем статистику…</p>:<>
      <div className="analytics-kpis">{metricCards.map(({label,value,icon:Icon})=><div className="analytics-kpi" key={label}><Icon size={16}/><span>{label}</span><b>{number(value)}</b></div>)}</div>
      <div className="book-analytics-legend"><span><UserRound size={14}/> Реальные посетители и читатели</span><span><Bot size={14}/> Автоматические отзывы и ответы</span></div>
      <div className="analytics-tabs" role="tablist" aria-label="Разделы аналитики">
        {[['books','По книгам'],['categories','По категориям'],['authors','По авторам'],['search','Поисковые запросы']].map(([id,label])=><button type="button" role="tab" aria-selected={section===id} className={section===id?'active':''} key={id} onClick={()=>selectSection(id)}>{label}</button>)}
      </div>
      <div className="analytics-table-toolbar"><label className="analytics-search"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder={section==='search'?'Найти поисковый запрос…':'Поиск по таблице…'}/></label><span>{visibleRows.length} строк</span></div>
      <div className="book-analytics-table-wrap"><table className="book-analytics-table">
        <thead><tr>{columns.map(([key,label])=><SortHead key={key} column={key} label={label} sort={sort} onSort={changeSort}/>)}</tr></thead>
        <tbody>{visibleRows.map((row,index)=><tr key={row.book_id||row.query_normalized||row.category||row.author||index}>{columns.map(([key,,type])=><td key={key}>{type==='number'?number(row[key]):type==='date'?dateLabel(row[key]):String(row[key]??'—')}</td>)}</tr>)}
          {!visibleRows.length&&<tr><td colSpan={columns.length} className="analytics-empty">{search?'По этому запросу ничего не найдено.':'Пока нет данных для отображения.'}</td></tr>}
        </tbody>
      </table></div>
      {section==='search'&&<div className="analytics-search-summary"><h3>Поисковые запросы за выбранный период</h3><p>Сохраняются запросы длиной от двух символов. Повтор одного и того же запроса с одного браузера в течение 10 минут не учитывается повторно.</p><div className="analytics-daily-list">{daily.map(day=><div className="analytics-daily-row" key={day.search_day}><span>{dateLabel(day.search_day)}</span><div><i style={{width:Math.max(2,Math.min(100,Number(day.searches)/Math.max(1,...daily.map(x=>Number(x.searches)))*100))+'%'}}/></div><b>{number(day.searches)}</b><small>без результата: {number(day.no_results)}</small></div>)}</div></div>}
      <small className="book-analytics-footnote">* Уникальные посетители — псевдонимные идентификаторы браузеров, а не подтверждённые личности. Поисковые запросы не связываются с аккаунтами; текст запроса ограничен 100 символами. Боты не учитываются как посетители или читатели. Исторические поиски до включения этой функции недоступны.</small>
    </>}
  </section>;
}
