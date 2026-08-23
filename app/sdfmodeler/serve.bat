@echo off
rem sdfmodeler 起動スクリプト (Windows)
cd /d "%~dp0"
set PORT=8642
start "" http://localhost:%PORT%
py serve.py %PORT% 2>nul || python serve.py %PORT%
