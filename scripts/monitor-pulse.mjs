#!/usr/bin/env node
/**
 * Пульс для внешнего наблюдателя (блок 8, 8.2 «Независимый контроль пульса»;
 * 2.1-W08a).
 *
 * Отметка уходит, только если Zabbix сам свежо работает: через его API
 * читается время последнего значения контрольного элемента `agent.ping`.
 * API берёт это из базы Zabbix, поэтому свежая отметка подтверждает и
 * сервер, и его базу. Зависший или остановленный Zabbix, отказ его базы,
 * недоступный API — отметки нет, а на сервис уходит `/fail`: внешний
 * наблюдатель сообщает сразу, не дожидаясь допуска.
 *
 * Остановка ядра пульс не прерывает — о ядре сообщает сам Zabbix.
 *
 *   node scripts/monitor-pulse.mjs        один раз (таймер узла — раз в минуту)
 *
 * HEALTHCHECKS_PING_URL — секрет (адрес пинга), без него команда только
 * сообщает состояние. ZABBIX_PULSE_API_TOKEN — токен учётки «5e-pulse»
 * (только чтение), его заводит `monitoring.mjs configure`.
 */
import { loadEnv } from './lib/backup.mjs';
import { zabbixApi } from './lib/zabbix-api.mjs';

loadEnv();
const env = process.env;
const HOST = env.ZABBIX_HOST_NAME || (env.MONITOR_ENV === 'vps' ? '5e-vps' : '5e-stand');
const FRESH_SEC = Number(env.MONITOR_PULSE_FRESH_SEC || 180);

async function zabbixFresh() {
  if (!env.ZABBIX_PULSE_API_TOKEN) return { ok: false, reason: 'нет токена API пульса' };
  const api = zabbixApi(`http://127.0.0.1:${env.ZABBIX_WEB_PORT || 8090}/api_jsonrpc.php`);
  api.useToken(env.ZABBIX_PULSE_API_TOKEN);
  try {
    const [item] = await api.call('item.get', {
      host: HOST,
      filter: { key_: 'agent.ping' },
      output: ['lastclock'],
    });
    if (!item) return { ok: false, reason: 'контрольный элемент не найден' };
    const age = Math.round(Date.now() / 1000 - Number(item.lastclock));
    return age <= FRESH_SEC
      ? { ok: true, reason: `контрольная отметка ${age} с назад` }
      : { ok: false, reason: `контрольная отметка устарела: ${age} с` };
  } catch (error) {
    return { ok: false, reason: `API Zabbix недоступен: ${error.message.slice(0, 120)}` };
  }
}

const state = await zabbixFresh();
const url = env.HEALTHCHECKS_PING_URL;
if (url) {
  try {
    await fetch(state.ok ? url : `${url}/fail`, {
      method: 'POST',
      body: state.reason,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Недоставленная отметка — тоже сигнал: внешний сервис заметит пропуск.
  }
}
console.log(
  `${state.ok ? 'пульс' : 'ОТКАЗ'}: ${state.reason}${url ? '' : ' (адрес пинга не задан — только проверка)'}`,
);
process.exit(state.ok ? 0 : 1);
