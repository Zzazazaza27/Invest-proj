# Вход на VPS: личные учётки вместо общего root

Блок 5, задание 1. Выполняет Томас: это настройки безопасности сервера. Значения паролей и закрытые
ключи в чат не передаются.

## Что сейчас

- Вход по паролю и root-вход разрешены, в `root` два ключа: `SERG` и `rebel_diesel`.
- Группа `sudo` пуста, личных учёток нет.
- Ubuntu 24.04. `Include /etc/ssh/sshd_config.d/*.conf` стоит в начале `sshd_config`, поэтому файл из
  этого каталога важнее строки `PermitRootLogin yes` ниже.
- Закрыто снаружи: 4300, 4400, 5433, 9000, 10051, 8083. Открыто: 22, почта, сайт.

## Часть 1. Учётки, старый вход работает

Команды на ноутбуке — в обычном терминале PowerShell или Git Bash.

1. Проверь аварийную консоль в панели хостера: она открывается, вход под root проходит. Без этого к
   части 2 не переходить.

2. Создай ключи. Для своего задай парольную фразу. Для ключа Мауса фразу оставь пустой: его скрипты
   работают без участия человека.

   ```bash
   ssh-keygen -t ed25519 -f $HOME/.ssh/thomas_5e -C thomas
   ```

   ```bash
   ssh-keygen -t ed25519 -f $HOME/.ssh/maus_5e -C maus
   ```

3. Передай открытые ключи на сервер:

   ```bash
   scp -i $HOME/.ssh/launchbridge_ed25519 $HOME/.ssh/thomas_5e.pub $HOME/.ssh/maus_5e.pub root@193.233.217.210:/root/
   ```

4. Открой сессию root. Она остаётся открытой до конца работы:

   ```bash
   ssh -i $HOME/.ssh/launchbridge_ed25519 root@193.233.217.210
   ```

5. В этой сессии заведи учётки. `sudo` без пароля нужен обеим: у учёток нет паролей. Сужение прав —
   задание 3 блока 5.

   ```bash
   for u in thomas maus; do
     adduser --disabled-password --gecos "" "$u"
     usermod -aG sudo "$u"
     install -d -m 700 -o "$u" -g "$u" "/home/$u/.ssh"
     install -m 600 -o "$u" -g "$u" "/root/${u}_5e.pub" "/home/$u/.ssh/authorized_keys"
     echo "$u ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$u"
     chmod 440 "/etc/sudoers.d/90-$u"
     visudo -cf "/etc/sudoers.d/90-$u"
     rm "/root/${u}_5e.pub"
   done
   ```

6. В новом окне на ноутбуке проверь обе учётки. Ожидается `ok thomas` и `ok maus`:

   ```bash
   ssh -i $HOME/.ssh/thomas_5e -o IdentitiesOnly=yes thomas@193.233.217.210 "sudo -n true && echo ok thomas"
   ```

   ```bash
   ssh -i $HOME/.ssh/maus_5e -o IdentitiesOnly=yes -o BatchMode=yes maus@193.233.217.210 "sudo -n true && echo ok maus"
   ```

7. Скажи Маусу, что учётки готовы. Он переводит свои скрипты на `maus` и проверяет скачивание резервной
   копии. Закрывать старый вход до его ответа нельзя: скачивание с ноутбука остановится.

## Часть 2. Закрытие старого входа, после ответа Мауса

8. В сессии root из шага 4:

   ```bash
   printf 'PermitRootLogin no\nPasswordAuthentication no\n' > /etc/ssh/sshd_config.d/10-personal-login.conf
   ```

   ```bash
   sshd -t && systemctl reload ssh && sshd -T | grep -E '^(permitrootlogin|passwordauthentication) '
   ```

   Ожидается `permitrootlogin no` и `passwordauthentication no`.

9. В новом окне на ноутбуке. Первая команда должна сработать, вторая — получить отказ:

   ```bash
   ssh -i $HOME/.ssh/thomas_5e -o IdentitiesOnly=yes thomas@193.233.217.210 "sudo -n true && echo ok thomas"
   ```

   ```bash
   ssh -i $HOME/.ssh/launchbridge_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes root@193.233.217.210 "echo root ещё открыт"
   ```

   Проверка отказа по паролю:

   ```bash
   ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 root@193.233.217.210
   ```

   Ожидается `Permission denied` без запроса пароля.

   Если вход под `thomas` не прошёл — верни прежнее из сессии root:

   ```bash
   rm /etc/ssh/sshd_config.d/10-personal-login.conf && systemctl reload ssh
   ```

10. Удали ключи `SERG` и `rebel_diesel` из `root`. Сессию root после этого можно закрыть.

    ```bash
    sed -i -E '/ (SERG|rebel_diesel)$/d' /root/.ssh/authorized_keys && wc -l /root/.ssh/authorized_keys
    ```

    Ожидается `0`.

11. Смени раскрытый пароль root через KeePassXC, когда он будет готов. Пароль остаётся только для
    аварийной консоли.
