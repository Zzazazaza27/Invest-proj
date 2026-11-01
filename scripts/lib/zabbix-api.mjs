/**
 * Минимальный клиент API Zabbix 7.0 (JSON-RPC) для конфигурации наблюдения
 * как кода (блок 8, 2.1-W08a). Токен — в заголовке, в журнал не пишется.
 */
export function zabbixApi(url) {
  let id = 1;
  let auth = null;
  const call = async (method, params = {}) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json-rpc',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: id++ }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.data || j.error.message}`);
    return j.result;
  };
  return {
    call,
    async login(username, password) {
      auth = null;
      auth = await call('user.login', { username, password });
      return true;
    },
    useToken(token) {
      auth = token;
    },
    /** Создать или обновить объект по поиску: get → update или create. */
    async upsert(kind, idField, filter, body) {
      const found = await call(`${kind}.get`, { filter, output: [idField] });
      if (found.length) {
        await call(`${kind}.update`, { [idField]: found[0][idField], ...body });
        return found[0][idField];
      }
      const created = await call(`${kind}.create`, body);
      return created[`${idField}s`][0];
    },
  };
}
