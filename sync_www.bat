@echo off
rem Publish esp-emu-peris into the esp-emu-browser www directory.
python "%~dp0sync_www.py" %*
