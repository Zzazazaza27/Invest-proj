@echo off
rem Запуск шлюза анализа вне сессии, из которой поднимают стенд (stand-up.mjs, через explorer.exe).
rem Процесс становится потомком Проводника и переживает автообновление Claude.
cd /d "%~dp0..\.."
node scripts\dev-ai-gateway.mjs --detached
