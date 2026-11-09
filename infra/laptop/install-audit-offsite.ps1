# Вынос выгрузки журнала аудита на ноутбук Томаса (2.1.5): задание расписания Windows.
# Устанавливается только по согласованию с Томасом. Запуск от его учётной записи:
#   powershell -ExecutionPolicy Bypass -File infra\laptop\install-audit-offsite.ps1
# Снять:
#   Unregister-ScheduledTask -TaskName "5E audit offsite" -Confirm:$false
#
# Что делает задание: раз в сутки (пропущенное — при первой возможности) без окна запускает
#   node scripts/audit-offsite.mjs pull
# в D:\Programming\fifth-element. Порции рабочей среды и test-2 забираются по SSH ключом
# maus (только чтение через fifth-backup-read), проверяются подписью и контрольной точкой и
# сохраняются в D:\cloud@mail.ru\projects\5E\audit-export\prod и \test-2. Работает, пока
# Томас вошёл в систему; права обычные (без повышения).
$ErrorActionPreference = 'Stop'
$repo = 'D:\Programming\fifth-element'
$name = '5E audit offsite'
$node = (Get-Command node).Source
# Полное имя учётной записи «КОМПЬЮТЕР\имя»: без него планировщик отвергает пользователя.
$user = "$env:USERDOMAIN\$env:USERNAME"
if (-not (Test-Path "$repo\infra\audit\export-signing.pub")) { throw 'нет закреплённого ключа выгрузки' }
if (-not (Test-Path "$env:USERPROFILE\.ssh\maus_5e")) { throw 'нет ключа SSH maus_5e' }
# Без окна консоли: node.exe напрямую каждый раз открывал окно (Томас, 09.11). Обёртка
# скрывает его и возвращает код завершения — «результат» задания остаётся честным.
$hidden = "$repo\infra\laptop\run-hidden.vbs"
if (-not (Test-Path $hidden)) { throw 'нет обёртки run-hidden.vbs' }
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" `
  -Argument "//B //Nologo `"$hidden`" `"$node`" scripts/audit-offsite.mjs pull" -WorkingDirectory $repo
# Раз в сутки (Томас, 09.11: пока на prod нет пользователей; порог тревоги — 72 ч). Пропущенный
# из-за выключенного ноутбука запуск выполняется при первой возможности (StartWhenAvailable).
# При выходе в прод — снова ежечасно (TODO сейфа, «Перед выходом в прод»).
$daily = New-ScheduledTaskTrigger -Daily -At '13:20'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($daily) -Settings $settings `
  -Principal $principal -Description '5E: вынос выгрузки журнала аудита (2.1.5)' -Force | Out-Null
Write-Output "задание «$name» установлено: раз в сутки в 13:20, без окна"
Start-ScheduledTask -TaskName $name
Write-Output 'первый вынос запущен; проверка: node scripts/audit-offsite.mjs check'
