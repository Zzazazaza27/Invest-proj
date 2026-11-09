# Вынос выгрузки журнала аудита на ноутбук Томаса (2.1.5): задание расписания Windows.
# Устанавливается только по согласованию с Томасом. Запуск от его учётной записи:
#   powershell -ExecutionPolicy Bypass -File infra\laptop\install-audit-offsite.ps1
# Снять:
#   Unregister-ScheduledTask -TaskName "5E audit offsite" -Confirm:$false
#
# Что делает задание: раз в час (и через 5 минут после входа) запускает
#   node scripts/audit-offsite.mjs pull
# в D:\Programming\fifth-element. Порции рабочей среды и test-2 забираются по SSH ключом
# maus (только чтение через fifth-backup-read), проверяются подписью и контрольной точкой и
# сохраняются в D:\cloud@mail.ru\projects\5E\audit-export\prod и \test-2. Работает, пока
# Томас вошёл в систему; права обычные (без повышения).
$ErrorActionPreference = 'Stop'
$repo = 'D:\Programming\fifth-element'
$name = '5E audit offsite'
$node = (Get-Command node).Source
if (-not (Test-Path "$repo\infra\audit\export-signing.pub")) { throw 'нет закреплённого ключа выгрузки' }
if (-not (Test-Path "$env:USERPROFILE\.ssh\maus_5e")) { throw 'нет ключа SSH maus_5e' }
$action = New-ScheduledTaskAction -Execute $node -Argument 'scripts/audit-offsite.mjs pull' -WorkingDirectory $repo
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(20) -RepetitionInterval (New-TimeSpan -Hours 1)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT5M'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($hourly, $logon) -Settings $settings `
  -Principal $principal -Description '5E: вынос выгрузки журнала аудита (2.1.5)' -Force | Out-Null
Write-Output "задание «$name» установлено: раз в час и через 5 минут после входа"
Start-ScheduledTask -TaskName $name
Write-Output 'первый вынос запущен; проверка: node scripts/audit-offsite.mjs check'
