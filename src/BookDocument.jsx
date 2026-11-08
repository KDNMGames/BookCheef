import React,{useEffect,useState} from 'react';
import mammoth from 'mammoth';
import DOMPurify from 'dompurify';

const IMAGE_FALLBACK='data:image/svg+xml;charset=UTF-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420"><rect width="640" height="420" fill="#211d29"/><g fill="none" stroke="#a98b5d" stroke-width="12"><rect x="220" y="105" width="200" height="180" rx="14"/><circle cx="275" cy="160" r="18"/><path d="m235 260 65-65 42 42 30-30 33 53"/></g><text x="320" y="345" fill="#d7c6a7" font-family="sans-serif" font-size="22" text-anchor="middle">Изображение недоступно</text></svg>');
function handleImageError(event){
  const image=event.target;
  if(image?.tagName!=='IMG'||image.dataset.imageFallback==='true')return;
  image.dataset.imageFallback='true';
  image.src=IMAGE_FALLBACK;
  image.alt=image.alt?'Изображение недоступно: '+image.alt:'Изображение недоступно';
}

export default function BookDocument({url,fileName='',fileType=''}) {
  const [html,setHtml]=useState('');
  const [text,setText]=useState('');
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const type=(fileType||fileName.split('.').pop()||'').toLowerCase();

  useEffect(()=>{
    let active=true;
    async function read(){
      setLoading(true);setError('');setHtml('');setText('');
      try{
        if(type==='pdf'||['png','jpg','jpeg','webp','gif','bmp','avif','svg'].includes(type)){setLoading(false);return;}
        const response=await fetch(url);
        if(!response.ok)throw new Error('Не удалось загрузить документ ('+response.status+').');
        if(type==='docx'){
          const buffer=await response.arrayBuffer();
          const result=await mammoth.convertToHtml({arrayBuffer:buffer},{
            convertImage:mammoth.images.inline(async image=>({src:'data:'+image.contentType+';base64,'+await image.read('base64')}))
          });
          if(active)setHtml(DOMPurify.sanitize(result.value,{ALLOWED_URI_REGEXP:/^(?:(?:https?|mailto|tel):|data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,)/i}));
        }else if(['txt','md','markdown','rtf'].includes(type)){
          const value=await response.text();
          const clean=type==='rtf'?value.replace(/\\\\'[0-9a-f]{2}/gi,'').replace(/\\\\[a-z]+-?\\d* ?/gi,'').replace(/[{}]/g,''):value;
          if(active)setText(clean.replace(/^\\uFEFF/,''));
        }else if(['html','htm'].includes(type)){
          const value=await response.text();
          if(active)setHtml(DOMPurify.sanitize(value));
        }else{
          throw new Error('Формат .'+type+' не поддерживается для чтения. Можно скачать оригинал.');
        }
      }catch(e){if(active)setError(e.message||'Ошибка чтения документа.');}
      finally{if(active)setLoading(false);}
    }
    read();
    return()=>{active=false;};
  },[url,type]);

  if(type==='pdf')return <div className="document-viewer pdf-viewer"><iframe title={fileName||'PDF книга'} src={url+'#toolbar=1&navpanes=0'} /><a href={url} target="_blank" rel="noreferrer">Открыть PDF в отдельной вкладке</a></div>;
  if(['png','jpg','jpeg','webp','gif','bmp','avif','svg'].includes(type))return <figure className="document-image-viewer"><img src={url} alt={fileName||'Иллюстрация книги'} onError={handleImageError}/></figure>;
  if(loading)return <p className="document-status">Загружаем документ…</p>;
  if(error)return <div className="document-error">{error}<p><a href={url} target="_blank" rel="noreferrer">Скачать исходный файл</a></p></div>;
  if(type==='docx'||type==='html'||type==='htm')return <div className="docx-content" onErrorCapture={handleImageError} dangerouslySetInnerHTML={{__html:html}}/>;
  return <pre className="txt-content">{text}</pre>;
}
