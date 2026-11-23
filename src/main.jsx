import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './style.css';
if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('/BookCheef/sw.js').catch(error=>console.warn('Offline cache unavailable:',error)));}
createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
