import React,{useCallback,useEffect,useMemo,useState} from 'react';
import {supabase} from './supabase';
import {RefreshCw,UserRound,Bot,Search,BookOpen,Users,Eye,MessageCircle,TrendingUp,CalendarDays,Gift,Crown,UserPlus,UserMinus,Trash2} from 'lucide-react';

const number=value=>Number(value||0).toLocaleString('ru-RU');
const dateLabel=value=>value?new Date(value).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'2-digit'}):'—';
const proEventLabel=value=>({activated:'Новая активация',reactivated:'Возврат подписчика',renewed:'Продление',expired:'Подписка закончилась',legacy_active:'Активна до запуска аналитики'}[value]||value);

function SortHead({column,label,sort,onSort}) {
  const active=sort.key===column;
  return <th aria-sort={active?(sort.direction==='asc'?'ascending':'descending'):'none'}>
    <button type="button" className="analytics-sort" onClick={()=>onSort(column)}>{label}<span>{active?(sort.direction==='asc'?'↑':'↓'):'↕'}</span></button>
  </th>;
}

function MiniBars({rows,dateKey,series}) {
  const max=Math.max(1,...rows.flatMap(row=>series.map(item=>Number(row[item.key]||0))));
  return <div className="analytics-daily-list">{rows.map(row=><div className="analytics-daily-row" key={row[dateKey]}>
    <span>{dateLabel(row[dateKey])}</span>
    <div className="analytics-multi-bars">{series.map(item=><i key={item.key} title={item.label+': '+number(row[item.key])} style={{width:Math.max(1,Number(row[item.key]||0)/max*100)+'%'}}/>)}</div>
    <b>{number(series.reduce((sum,item)=>sum+Number(row[item.key]||0),0))}</b>
    <small>{series.map(item=>item.short+': '+number(row[item.key])).join(' · ')}</small>
  </div>)}</div>;
}

export default function BookAnalytics({books=[]}) {
  const [rows,setRows]=useState([]);
  const [dashboard,setDashboard]=useState(null);
  const [growth,setGrowth]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [section,setSection]=useState('books');
  const [search,setSearch]=useState('');
  const [sort,setSort]=useState({key:'total_views',direction:'desc'});

  const reload=useCallback(async()=>{
    setLoading(true);setError('');
    const [bookResult,dashboardResult,growthResult]=await Promise.all([
      supabase.rpc('get_book_analytics'),
      supabase.rpc('get_book_analytics_dashboard',{p_days:7}),
      supabase.rpc('get_growth_analytics_dashboard',{p_days:30})
    ]);
    const failure=bookResult.error||dashboardResult.error||growthResult.error;
    if(failure){
      setError(failure.message||'Не удалось загрузить аналитику.');
    } else {
      setRows(bookResult.data||[]);
      setDashboard(dashboardResult.data||null);
      setGrowth(growthResult.data||null);
    }
    setLoading(false);
  },[]);
  useEffect(()=>{reload();},[reload]);

  const bookInfo=useMemo(()=>new Map(books.map(book=>[String(book.id),book])),[books]);
  const totals=dashboard?.totals||{};
  const categories=dashboard?.categories||[];
  const authors=dashboard?.authors||[];
  const terms=dashboard?.search_terms||[];
  const daily=dashboard?.search_daily||[];
  const promoTotals=growth?.promo_totals||{};
  const promoRows=growth?.promo_codes||[];
  const proSummary=growth?.pro_summary||{};
  const proEvents=growth?.pro_events||[];
  const userSummary=growth?.user_summary||{};
  const proDaily=growth?.pro_daily||[];
  const userDaily=growth?.user_daily||[];

  const userRows=[
    {metric:'Всего зарегистрировано',count:userSummary.total_users,description:'Все действующие аккаунты'},
    {metric:'Новые регистрации',count:userSummary.new_users,description:'За последние 30 дней'},
    {metric:'Активны за 7 дней',count:userSummary.active_7d,description:'Есть подтверждённая активность за неделю'},
    {metric:'Активны за 30 дней',count:userSummary.active_30d,description:'Есть подтверждённая активность за месяц'},
    {metric:'Неактивны 30+ дней',count:userSummary.inactive_30d,description:'Нет активности более 30 дней'},
    {metric:'Неактивны 90+ дней',count:userSummary.inactive_90d,description:'Нет активности более 90 дней'},
    {metric:'Удалили аккаунт',count:userSummary.deleted_users,description:'Удаления за последние 30 дней'}
  ];
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
    if(section==='search')return [
      ['query','Поисковый запрос','text'],['search_count','Поисков','number'],['unique_visitors','Посетителей','number'],
      ['no_results','Без результатов','number'],['average_results','Среднее число книг','number'],['last_searched','Последний поиск','date']
    ];
    if(section==='promo')return [
      ['code','Промокод','text'],['duration_months','Месяцев Pro','number'],['redemption_count','Активаций','number'],
      ['unique_users','Уникальных пользователей','number'],['recent_redemptions','Активаций за 30 дней','number'],
      ['used_count','Счётчик использований','number'],['max_uses','Лимит','number'],['last_redeemed','Последняя активация','date']
    ];
    if(section==='pro')return [
      ['label','Событие Pro','text'],['event_count','Количество','number'],['unique_users','Подписчиков','number'],['last_event','Последнее событие','date']
    ];
    return [
      ['metric','Показатель','text'],['count','Пользователей','number'],['description','Описание','text']
    ];
  },[section]);

  const sourceRows=section==='books'
    ?rows.map(row=>({...row,author:bookInfo.get(String(row.book_id))?.author||'Автор не указан',category:bookInfo.get(String(row.book_id))?.category||'Без категории'}))
    :section==='categories'?categories
    :section==='authors'?authors
    :section==='search'?terms
    :section==='promo'?promoRows
    :section==='pro'?proEvents.map(row=>({...row,label:proEventLabel(row.event_type)}))
    :userRows;

  const visibleRows=useMemo(()=>{
    const q=search.trim().toLocaleLowerCase('ru-RU');
    const filtered=sourceRows.filter(row=>!q||columns.some(([key,,type])=>String(type==='date'?dateLabel(row[key]):row[key]??'').toLocaleLowerCase('ru-RU').includes(q)));
    return filtered.sort((a,b)=>{
      const key=sort.key;let av=a[key]??'',bv=b[key]??'';
      if(['last_searched','last_redeemed','last_event'].includes(key)){av=av?new Date(av).getTime():0;bv=bv?new Date(bv).getTime():0;}
      else if(typeof av==='number'||typeof bv==='number'||columns.find(c=>c[0]===key)?.[2]==='number'){av=Number(av)||0;bv=Number(bv)||0;}
      else {av=String(av).toLocaleLowerCase('ru-RU');bv=String(bv).toLocaleLowerCase('ru-RU');}
      const result=av<bv?-1:av>bv?1:0;
      return sort.direction==='asc'?result:-result;
    });
  },[sourceRows,search,columns,sort]);

  function changeSort(key){setSort(current=>current.key===key?{key,direction:current.direction==='asc'?'desc':'asc'}:{key,direction:['title','author','category','query','code','label','metric','description'].includes(key)?'asc':'desc'});}
  function selectSection(next){
    setSection(next);setSearch('');
    const defaults={books:'total_views',categories:'total_views',authors:'total_views',search:'search_count',promo:'redemption_count',pro:'event_count',users:'count'};
    setSort({key:defaults[next]||'total_views',direction:'desc'});
  }

  const metricCards=[
    {label:'Книг в каталоге',value:totals.books,icon:BookOpen},
    {label:'Просмотры книг',value:totals.views,icon:Eye},
    {label:'Уникальные посетители*',value:totals.unique_visitors,icon:Users},
    {label:'Начали читать',value:totals.started_readers,icon:BookOpen},
    {label:'Завершили чтение',value:totals.completed_readers,icon:BookOpen},
    {label:'Отзывы людей',value:totals.human_reviews,icon:MessageCircle},
    {label:'Отзывы ботов',value:totals.bot_reviews,icon:Bot},
    {label:'Поиски за 7 дней',value:totals.searches,icon:Search},
    {label:'Поиски без результата',value:totals.search_no_results,icon:TrendingUp},
    {label:'Активные Pro',value:proSummary.active_subscribers,icon:Crown},
    {label:'Пользователи',value:userSummary.total_users,icon:Users},
    {label:'Новые за 30 дней',value:userSummary.new_users,icon:UserPlus}
  ];

  return <section className="panel book-analytics-panel">
    <div className="panel-title"><div><h2>Аналитика BookCheef</h2><p className="panel-hint">Книги, подписки, промокоды и активность пользователей</p></div><button type="button" className="ghost book-analytics-refresh" onClick={reload} disabled={loading}><RefreshCw size={15} className={loading?'spin':''}/> Обновить</button></div>
    <div className="analytics-period"><CalendarDays size={15}/><span>Поисковая аналитика хранится только за последние 7 дней.</span><small>Данные по пользователям и подпискам — за 30 дней и накопительно.</small></div>
    {error&&<div className="error" role="alert">{error}</div>}
    {loading&&!dashboard?<p className="muted">Загружаем статистику…</p>:<>
      <div className="analytics-kpis">{metricCards.map(({label,value,icon:Icon})=><div className="analytics-kpi" key={label}><Icon size={16}/><span>{label}</span><b>{number(value)}</b></div>)}</div>
      <div className="book-analytics-legend"><span><UserRound size={14}/> Реальные посетители и читатели</span><span><Bot size={14}/> Автоматические отзывы и ответы</span></div>
      <div className="analytics-tabs" role="tablist" aria-label="Разделы аналитики">
        {[['books','По книгам'],['categories','По категориям'],['authors','По авторам'],['search','Поисковые запросы'],['promo','Промокоды'],['pro','Подписки Pro'],['users','Пользователи']].map(([id,label])=><button type="button" role="tab" aria-selected={section===id} className={section===id?'active':''} key={id} onClick={()=>selectSection(id)}>{label}</button>)}
      </div>
      {section==='promo'&&<div className="analytics-context-grid">
        {[['Всего промокодов',promoTotals.codes,Gift],['Всего активаций',promoTotals.redemptions,TrendingUp],['Уникальных пользователей',promoTotals.unique_users,Users],['Активаций за 30 дней',promoTotals.recent_redemptions,CalendarDays]].map(([label,value,Icon])=><div className="analytics-kpi" key={label}><Icon size={16}/><span>{label}</span><b>{number(value)}</b></div>)}
      </div>}
      {section==='pro'&&<div className="analytics-context-grid">
        {[['Активные подписчики',proSummary.active_subscribers,Crown],['Новые подключения',proSummary.new_activations,UserPlus],['Вернулись',proSummary.reactivations,TrendingUp],['Продления',proSummary.renewals,CalendarDays],['Закончились',proSummary.outgoing,UserMinus],['Базовые подписки до аналитики',proSummary.legacy_active,Users]].map(([label,value,Icon])=><div className="analytics-kpi" key={label}><Icon size={16}/><span>{label}</span><b>{number(value)}</b></div>)}
      </div>}
      {section==='users'&&<div className="analytics-context-grid">
        {[['Всего аккаунтов',userSummary.total_users,Users],['Новые за 30 дней',userSummary.new_users,UserPlus],['Активны 7 дней',userSummary.active_7d,TrendingUp],['Активны 30 дней',userSummary.active_30d,Users],['Неактивны 30+ дней',userSummary.inactive_30d,UserMinus],['Неактивны 90+ дней',userSummary.inactive_90d,UserMinus],['Удалено за 30 дней',userSummary.deleted_users,Trash2]].map(([label,value,Icon])=><div className="analytics-kpi" key={label}><Icon size={16}/><span>{label}</span><b>{number(value)}</b></div>)}
      </div>}
      <div className="analytics-table-toolbar"><label className="analytics-search"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder={section==='search'?'Найти поисковый запрос…':'Поиск по таблице…'}/></label><span>{visibleRows.length} строк</span></div>
      <div className="book-analytics-table-wrap"><table className="book-analytics-table">
        <thead><tr>{columns.map(([key,label])=><SortHead key={key} column={key} label={label} sort={sort} onSort={changeSort}/>)}</tr></thead>
        <tbody>{visibleRows.map((row,index)=><tr key={row.book_id||row.query_normalized||row.code||row.event_type||row.metric||row.category||row.author||index}>{columns.map(([key,,type])=><td key={key}>{type==='number'?number(row[key]):type==='date'?dateLabel(row[key]):String(row[key]??'—')}</td>)}</tr>)}
          {!visibleRows.length&&<tr><td colSpan={columns.length} className="analytics-empty">{search?'По этому запросу ничего не найдено.':'Пока нет данных для отображения.'}</td></tr>}
        </tbody>
      </table></div>
      {section==='search'&&<div className="analytics-search-summary"><h3>Поисковые запросы за последние 7 дней</h3><p>Сохраняются запросы длиной от двух символов. Повтор одного и того же запроса с одного браузера в течение 10 минут не учитывается повторно.</p><div className="analytics-daily-list">{daily.map(day=><div className="analytics-daily-row" key={day.search_day}><span>{dateLabel(day.search_day)}</span><div><i style={{width:Math.max(2,Math.min(100,Number(day.searches)/Math.max(1,...daily.map(x=>Number(x.searches)))*100))+'%'}}/></div><b>{number(day.searches)}</b><small>без результата: {number(day.no_results)}</small></div>)}</div></div>}
      {section==='pro'&&<div className="analytics-search-summary"><h3>Приход и уход подписчиков Pro · 30 дней</h3><p>Подключение и повторная активация считаются приходом; окончание срока — уходом. Продления показываются отдельно.</p><MiniBars rows={proDaily} dateKey="date" series={[{key:'incoming',label:'Приход',short:'пришло'},{key:'renewals',label:'Продления',short:'продлено'},{key:'outgoing',label:'Уход',short:'ушло'}]}/></div>}
      {section==='users'&&<div className="analytics-search-summary"><h3>Приток и активность пользователей · 30 дней</h3><p>Регистрации и удаления — реальные события. Неактивность — расчётный показатель по последнему входу или посещению сайта.</p><MiniBars rows={userDaily} dateKey="date" series={[{key:'signups',label:'Регистрации',short:'регистрации'},{key:'deletions',label:'Удаления',short:'удаления'},{key:'active_users',label:'Активные',short:'активны'}]}/></div>}
      <small className="book-analytics-footnote">* Уникальные посетители — псевдонимные идентификаторы браузеров, а не подтверждённые личности. Поисковые запросы не связываются с аккаунтами; текст запроса ограничен 100 символами и автоматически удаляется через 7 дней. Боты не учитываются как посетители или читатели. Исторические поиски до включения этой функции недоступны. События Pro и удаления аккаунтов фиксируются с момента включения соответствующего учёта; для подписки, существовавшей ранее, дата подключения не угадывается. Неактивность не означает удаление аккаунта.</small>
    </>}
  </section>;
}
