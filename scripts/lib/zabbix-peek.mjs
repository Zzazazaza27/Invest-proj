/**
 * Сводка последних значений и неподдерживаемых проверок узла (для отладки
 * наблюдения и `monitoring.mjs status`). Значения секретных макросов не
 * выводятся — их в элементах нет.
 */
export async function peek(api, host) {
  const items = await api.call('item.get', {
    host,
    output: ['name', 'key_', 'lastvalue', 'lastclock', 'state', 'error'],
    sortfield: 'name',
  });
  const now = Date.now() / 1000;
  return items.map((i) => ({
    name: i.name,
    value: String(i.lastvalue).slice(0, 60),
    ageSec: Number(i.lastclock) ? Math.round(now - Number(i.lastclock)) : null,
    unsupported: i.state === '1' ? i.error.slice(0, 120) : null,
  }));
}
