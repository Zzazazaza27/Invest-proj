# OpenBao на VPS

Блок 5, задание 3. Команды выполняет Томас под `thomas`. Значения в чат не передаются. После этих шагов
OpenBao работает, но рабочие ключи в него ещё не перенесены: это задание 5.

## Размещение

| Что               | Где                                                 |
| ----------------- | --------------------------------------------------- |
| Контейнер         | `fifth-openbao`, проект `fifth-openbao`             |
| Адрес             | `https://127.0.0.1:8200`, снаружи закрыт            |
| Данные и аудит    | тома `fifth_openbaodata`, `fifth_openbaoaudit`      |
| Static seal key   | `/etc/fifth-openbao/seal/static.key`, вне копий     |
| Сертификат        | `/etc/fifth-openbao/tls`                            |
| Входы компонентов | `/etc/fifth-openbao/approle/<роль>`, только root    |
| Снимок            | `sets/<комплект>/openbao.snap`, без Static seal key |

Выпуск платформы OpenBao не перезапускает.

## Установка

Подготовь в KeePassXC записи: Static seal key, ключ восстановления, root-токен, пароль `thomas` в OpenBao.

```bash
cd /opt/fifth-element/infra/openbao
```

1. Файлы и запуск:

   ```bash
   sudo bash setup-vps.sh files
   ```

   ```bash
   sudo bash setup-vps.sh start
   ```

2. Инициализация. Ключ восстановления и root-токен показываются один раз, сразу сохрани оба:

   ```bash
   sudo bash setup-vps.sh init
   ```

3. Копия Static seal key в KeePassXC. Строка показывается только на экране:

   ```bash
   sudo bash setup-vps.sh seal-copy
   ```

4. Настройка. Спросит root-токен и новый пароль:

   ```bash
   sudo bash setup-vps.sh configure
   ```

5. Включение наблюдения:

   ```bash
   sudo cp /opt/fifth-element/infra/systemd/fifth-monitor-openbao.* /etc/systemd/system/
   ```

   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now fifth-monitor-openbao.timer
   ```

6. Проверь личный вход, затем отзови root-токен:

   ```bash
   sudo docker exec -it -e BAO_ADDR=https://127.0.0.1:8200 -e BAO_CACERT=/openbao/tls/tls.crt fifth-openbao bao login -method=userpass username=thomas
   ```

   ```bash
   sudo bash setup-vps.sh revoke
   ```

## Если OpenBao запечатан

- **Файл ключа цел:** перезапусти контейнер, он откроется сам.
- **Файл утрачен:** верни его из KeePassXC: строка `seal-copy` декодируется в файл, 32 байта, владелец
  uid 1990, права 400. Затем перезапусти контейнер. Ключ восстановления файл не заменяет.
- **Снимок без верного Static seal key не читается,** поэтому ключ и снимок хранятся раздельно.

## Смена Static seal key и миграция

Перед любой из этих работ сними снимок. Порядок проверен на искусственных ключах в
`scripts/check-openbao-ops.mjs`.

- **Смена ключа:** новый ключ в `current_key` с новым `current_key_id`, прежний в `previous_key`.
  Перезапуск, затем `previous_key` можно убрать.
- **Переход на ручную разблокировку:** в блоке seal `disabled = "true"`, перезапуск, `sys/unseal` с
  ключом восстановления и `migrate: true`, затем блок seal убрать.
- **Обратно:** блок seal с новым `current_key_id`, перезапуск, `sys/unseal` с `migrate: true`.
