import React,{useEffect,useState} from 'react';
import mammoth from 'mammoth';
import DOMPurify from 'dompurify';

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
        if(type==='pdf'||['png','jpg','jpeg','webp','gif','bmp','avif'].includes(type)){setLoading(false);return;}
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
  if(['png','jpg','jpeg','webp','gif','bmp','avif'].includes(type))return <figure className="document-image-viewer"><img src={url} alt={fileName||'Иллюстрация книги'}/></figure>;
  if(loading)return <p className="document-status">Загружаем документ…</p>;
  if(error)return <div className="document-error">{error}<p><a href={url} target="_blank" rel="noreferrer">Скачать исходный файл</a></p></div>;
  if(type==='docx'||type==='html'||type==='htm')return <div className="docx-content" dangerouslySetInnerHTML={{__html:html}}/>;
  return <pre className="txt-content">{text}</pre>;
}
