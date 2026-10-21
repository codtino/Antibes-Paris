# Crée une tâche planifiée Windows qui lance la vérification toutes les 15 minutes.
# Lancer une fois :  powershell -ExecutionPolicy Bypass -File installer_tache.ps1
# Pour la supprimer : Unregister-ScheduledTask -TaskName "Alerte TGV Max" -Confirm:$false

$script = Join-Path $PSScriptRoot "tgvmax_alerte.py"
$pythonw = (Get-Command pythonw).Source   # pythonw = pas de fenêtre noire

$action  = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$script`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
$options = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName "Alerte TGV Max" -Action $action -Trigger $trigger -Settings $options -Force
Write-Host "Tache 'Alerte TGV Max' installee : verification toutes les 15 min."
