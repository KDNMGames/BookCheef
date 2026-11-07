import React,{useMemo,useState} from 'react';
import {Headphones,BookOpen,Info} from 'lucide-react';
import BookAudioPlayer from './BookAudioPlayer.jsx';

export default function AdminAudioManager({books=[]}){
  const candidates=useMemo(()=>books.filter(book=>String(book.book_content||'').trim().length>0||(Array.isArray(book.interactive_content?.nodes)&&book.interactive_content.nodes.some(node=>String(node?.text||'').trim()))),[books]);
  const [selectedId,setSelectedId]=useState('');
  const selected=candidates.find(book=>String(book.id)===String(selectedId))||null;
  return <section className="panel admin-audio-manager">
    <div className="panel-title"><h2>Создание аудиокниг</h2><Headphones size={19}/></div>
    <p className="panel-hint">Новые обычные книги автоматически попадают в очередь озвучки после публикации. Фоновая задача обрабатывает главы постепенно и повторяет попытки после восстановления бесплатной квоты. Здесь можно вручную запустить или обновить аудиоверсию выбранной книги.</p>
    <label className="admin-audio-book-select">Книга для озвучки
      <select value={selectedId} onChange={event=>setSelectedId(event.target.value)}>
        <option value="">Выбери книгу…</option>
        {candidates.map(book=><option key={book.id} value={book.id}>{book.title}{book.is_interactive?' · интерактивная':''}</option>)}
      </select>
    </label>
    {selected?<BookAudioPlayer key={selected.id} book={selected} allowGeneration/>:
      <div className="admin-audio-empty"><BookOpen size={20}/><span>{candidates.length?'После выбора книги здесь появятся список глав и управление генерацией.':'Пока нет книг с текстом в поле «Текст книги». Книги, загруженные только отдельным PDF/DOCX, пока не поддерживаются.'}</span></div>}
    <div className="admin-audio-info"><Info size={15}/><span>Повторный запуск проверяет контрольную сумму текста: неизменённые главы не генерируются заново. Новые и изменённые главы будут озвучены.</span></div>
  </section>;
}
