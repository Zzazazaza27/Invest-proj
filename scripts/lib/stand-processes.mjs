/**
 * Процессы стенда, которые живут на хосте, а не в контейнерах.
 *
 * Ядро и AI-шлюз запускаются процессами: ядру нужен доступ к `.env` и к
 * собранному `dist`, шлюзу — к своему венву. Значит их надо уметь находить и
 * останавливать, а PID-файлов у них нет и заводить их незачем — единственный
 * надёжный признак живого сервиса это ЗАНЯТЫЙ ПОРТ, а не запись в файле,
 * которая переживает падение процесса.
 *
 * Поиск по порту решает и вторую задачу: останавливается именно тот процесс,
 * который отвечает на адресе, а не «что-то похожее по имени». Имя ловит чужое
 * (на машине могут работать другие node и python), порт — нет.
 */
import { execFileSync } from 'node:child_process';

/** Выполнить и вернуть stdout; при ошибке — пустая строка. */
function out(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/**
 * PID процесса, слушающего порт, или `null`.
 *
 * Слушающие сокеты отбираются явно: у порта бывают и установленные соединения
 * с чужими PID, и остановка по ним убила бы КЛИЕНТА вместо сервиса.
 */
export function portOwner(port) {
  if (process.platform === 'win32') {
    const rows = out('netstat', ['-ano', '-p', 'TCP']).split('\n');
    for (const row of rows) {
      const parts = row.trim().split(/\s+/);
      if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
      const local = parts[1] ?? '';
      if (!local.endsWith(`:${port}`)) continue;
      const pid = Number(parts[4]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return null;
  }
  const lsof = out('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    .trim()
    .split('\n')[0];
  const pid = Number(lsof);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Командная строка процесса — чтобы не остановить чужое молча. */
export function commandLine(pid) {
  if (process.platform === 'win32') {
    const raw = out('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]);
    return raw.trim();
  }
  return out('ps', ['-p', String(pid), '-o', 'args=']).trim();
}

/**
 * Остановить процесс вместе с его детьми.
 *
 * Дерево, а не один процесс: dev-сервер Vite и uvicorn с перезагрузкой держат
 * рабочего ребёнка, и остановка родителя оставляла бы порт занятым — со
 * стороны это выглядит как «скрипт соврал, что остановил».
 */
export function stopTree(pid) {
  if (process.platform === 'win32') {
    out('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  out('pkill', ['-TERM', '-P', String(pid)]);
  out('kill', ['-TERM', String(pid)]);
}
