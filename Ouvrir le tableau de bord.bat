@echo off
cd /d "%~dp0"
rem Récupère l'historique enregistré en ligne par GitHub Actions
git pull --quiet
python tgvmax_alerte.py --tableau
