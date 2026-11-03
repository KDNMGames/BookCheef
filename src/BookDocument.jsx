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
        if(type==='pdf'){setLoading(false);return;}
        const response=await fetch(url);
        if(!response.ok)throw new Error('Не удалось загрузить документ ('+response.status+').');
        if(type==='docx'){
          const buffer=await response.arrayBuffer();
          const result=await mammoth.convertToHtml({arrayBuffer:buffer},{
            convertImage:mammoth.images.inline(async image=>({src:'data:'+image.contentType+';base64,'+await image.read('base64')}))
          });
          if(active)setHtml(DOMPurify.sanitize(result.value));
        }else if(type==='txt'){
          const value=await response.text();
          if(active)setText(value.replace(/^\uFEFF/,''));
        }else{
          throw new Error('Формат .'+type+' пока не поддерживается. Загрузите DOCX, PDF или TXT.');
        }
      }catch(e){if(active)setError(e.message||'Ошибка чтения документа.');}
      finally{if(active)setLoading(false);}
    }
    read();
    return()=>{active=false;};
  },[url,type]);

  if(type==='pdf')return <div className="document-viewer pdf-viewer"><iframe title={fileName||'PDF книга'} src={url+'#toolbar=1&navpanes=0'} /><a href={url} target="_blank" rel="noreferrer">Открыть PDF в отдельной вкладке</a></div>;
  if(loading)return <p className="document-status">Загружаем документ…</p>;
  if(error)return <div className="document-error">{error}<p><a href={url} target="_blank" rel="noreferrer">Скачать исходный файл</a></p></div>;
  if(type==='docx')return <div className="docx-content" dangerouslySetInnerHTML={{__html:html}}/>;
  return <pre className="txt-content">{text}</pre>;
}
