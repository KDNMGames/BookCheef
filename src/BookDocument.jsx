import React,{useEffect,useState} from 'react';
import DOMPurify from 'dompurify';

const IMAGE_FALLBACK='data:image/svg+xml;charset=UTF-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420"><rect width="640" height="420" fill="#211d29"/><g fill="none" stroke="#a98b5d" stroke-width="12"><rect x="220" y="105" width="200" height="180" rx="14"/><circle cx="275" cy="160" r="18"/><path d="m235 260 65-65 42 42 30-30 33 53"/></g><text x="320" y="345" fill="#d7c6a7" font-family="sans-serif" font-size="22" text-anchor="middle">Изображение недоступно</text></svg>');
function sanitizeBookText(value){
  const fragment=DOMPurify.sanitize(value,{
    RETURN_DOM_FRAGMENT:true,
    ALLOWED_TAGS:['nav','h2','h3','p','ol','li','a','figure','img','figcaption','strong','em','br'],
    ALLOWED_ATTR:['id','class','href','src','alt','width','height','loading','decoding'],
    ALLOW_DATA_ATTR:false,
    ALLOWED_URI_REGEXP:/^#[a-z0-9][a-z0-9-]*$/,
  });
  for(const image of fragment.querySelectorAll('img')){
    if(!/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/=]+$/i.test(image.getAttribute('src')||''))image.removeAttribute('src');
  }
  const wrapper=document.createElement('div');wrapper.append(fragment);return wrapper.innerHTML;
}
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
  const native=type==='html'&&fileName.toLowerCase().endsWith('.bookcheef.html');

  useEffect(()=>{
    let active=true;
    const controller=new AbortController();
    async function read(){
      setLoading(true);setError('');setHtml('');setText('');
      try{
        if(type==='pdf'||['png','jpg','jpeg','webp','gif','bmp','avif','svg'].includes(type)){setLoading(false);return;}
        const response=await fetch(url,{signal:controller.signal,...(native?{cache:'no-store'}:{})});
        if(!response.ok)throw new Error('Не удалось загрузить документ ('+response.status+').');
        if(type==='docx'){
          const buffer=await response.arrayBuffer();
          const {default:mammoth}=await import('mammoth');
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
          if(active)setHtml(native?sanitizeBookText(value):DOMPurify.sanitize(value));
        }else{
          throw new Error('Формат .'+type+' не поддерживается для чтения. Можно скачать оригинал.');
        }
      }catch(e){if(active)setError(e.message||'Ошибка чтения документа.');}
      finally{if(active)setLoading(false);}
    }
    read();
    return()=>{active=false;controller.abort();};
  },[url,type,native]);

  function followChapter(event){
    const link=event.target.closest('a[href^="#"]');
    if(!link||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    const id=link.getAttribute('href').slice(1);
    if(!/^ch\d{3}$/.test(id))return;
    const heading=event.currentTarget.querySelector('#'+id);
    if(!heading)return;
    event.preventDefault();
    heading.tabIndex=-1;heading.focus({preventScroll:true});heading.scrollIntoView({behavior:'instant'});
  }
  if(type==='pdf')return <p className="document-status" data-reader-incomplete>Для этой книги пока нет текстовой версии.</p>;
  if(['png','jpg','jpeg','webp','gif','bmp','avif','svg'].includes(type))return <figure className="document-image-viewer"><img src={url} alt={fileName||'Иллюстрация книги'} onError={handleImageError}/></figure>;
  if(loading)return <p className="document-status" data-reader-incomplete data-reader-pending>Загружаем документ…</p>;
  if(error)return <div className="document-error" data-reader-incomplete>{error}{!native&&<p><a href={url} target="_blank" rel="noreferrer">Скачать исходный файл</a></p>}</div>;
  if(['docx','html','htm'].includes(type))return <div className={native?'bookcheef-native-text':'docx-content'} onClick={native?followChapter:undefined} onErrorCapture={handleImageError} dangerouslySetInnerHTML={{__html:html}}/>;
  return <pre className="txt-content">{text}</pre>;
}
