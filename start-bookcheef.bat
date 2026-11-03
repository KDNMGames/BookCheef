
@echo off
cd /d G:\BookCheef

start "" http://localhost:5173

node node_modules\vite\bin\vite.js --host 127.0.0.1
