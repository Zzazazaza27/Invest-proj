#!/usr/bin/env python3
"""Установка публичного SSH-ключа на сервер. Идемпотентно, чужие ключи не трогает.

Зачем скрипт, а не `ssh-copy-id`: тот требует ввода пароля с терминала, а заход
нужен повторяемым — сервер переустанавливают, и всё это делается заново.

ЧТО ДЕЛАЕТ
  1. заходит по паролю, печатает отпечаток ключа ХОСТА (сверь с панелью хостера
     при первом заходе после переустановки — это единственная защита от подмены
     сервера на этом шаге);
  2. читает authorized_keys через SFTP, БЕЗ интерпретации оболочкой: подстановка
     ключа в шелл-команду один раз уже дописала в файл мусор вместо ключа;
  3. дописывает наш ключ, если его там нет; чужие строки переносит как есть;
  4. перечитывает файл с сервера и проверяет результат;
  5. отдельным соединением заходит ТОЛЬКО по ключу — пароль не передаётся.
     Без этого шага «установлено» означает лишь «файл записан».

ПАРОЛЬ не передаётся аргументом (аргументы видны в списке процессов):
  либо переменная окружения SSH_ROOT_PASSWORD, либо --password-file <путь>.

ПОСЛЕ ПЕРЕУСТАНОВКИ СИСТЕМЫ ключ хоста другой, и старая запись в known_hosts
делает вход невозможным. Скрипт удаляет её сам (--forget-host по умолчанию).

ЗАВИСИМОСТЬ: paramiko (`pip install paramiko`). Проверяется при старте.

ПРИМЕРЫ
  SSH_ROOT_PASSWORD='...' python scripts/ssh-key-install.py --host 193.233.217.210
  python scripts/ssh-key-install.py --host 1.2.3.4 --user root --password-file pw.txt
"""

import argparse
import base64
import hashlib
import os
import pathlib
import stat
import subprocess
import sys

try:
    import paramiko
except ImportError:
    sys.exit("Нужен paramiko: pip install paramiko")

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_PUB = ROOT / ".ssh" / "SERG.pub"
KNOWN_HOSTS = ROOT / ".ssh" / "known_hosts"

# Консоль Windows по умолчанию не в UTF-8, и весь вывод ниже — русский. Без
# этого сообщения об ошибках превращаются в мусор ровно в тот момент, когда их
# надо прочитать.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# Тип ключа берётся из первого поля .pub: жёстко зашитый Ed25519Key падал бы на
# RSA/ECDSA-паре участника, хотя всё остальное в скрипте от типа не зависит.
KEY_CLASSES = {
    "ssh-ed25519": paramiko.Ed25519Key,
    "ssh-rsa": paramiko.RSAKey,
    "ecdsa-sha2-nistp256": paramiko.ECDSAKey,
    "ecdsa-sha2-nistp384": paramiko.ECDSAKey,
    "ecdsa-sha2-nistp521": paramiko.ECDSAKey,
}


def run(transport, cmd: str) -> str:
    """Выполнить команду поверх готового Transport и вернуть stdout."""
    chan = transport.open_session()
    try:
        chan.exec_command(cmd)
        chunks = []
        while True:
            data = chan.recv(4096)
            if not data:
                break
            chunks.append(data)
        chan.recv_exit_status()
        return b"".join(chunks).decode(errors="replace")
    finally:
        chan.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Установка публичного ключа на сервер")
    ap.add_argument("--host", required=True)
    ap.add_argument("--user", default="root")
    ap.add_argument("--port", type=int, default=22)
    ap.add_argument("--pub", default=str(DEFAULT_PUB), help="публичный ключ (.pub)")
    ap.add_argument("--password-file", help="файл с паролем; иначе SSH_ROOT_PASSWORD")
    ap.add_argument(
        "--keep-host-key",
        action="store_true",
        help="не удалять старую запись known_hosts (по умолчанию удаляется: "
        "после переустановки системы ключ хоста меняется)",
    )
    ap.add_argument(
        "--expect-host-key",
        help="ожидаемый отпечаток хоста (SHA256:...). Задан — сверяется до "
        "передачи пароля и при расхождении соединение рвётся. Не задан — "
        "отпечаток только печатается, и сверить его глазами обязан ты",
    )
    args = ap.parse_args()

    pub_path = pathlib.Path(args.pub)
    if not pub_path.is_file():
        return fail(f"нет файла публичного ключа: {pub_path}")
    pub = pub_path.read_text(encoding="utf-8").strip()
    parts = pub.split()
    if len(parts) < 2:
        return fail(f"{pub_path} не похож на публичный ключ")
    blob = parts[1]
    priv_path = pub_path.with_suffix("")
    if not priv_path.is_file():
        return fail(f"нет приватной части рядом: {priv_path}")

    if args.password_file:
        password = pathlib.Path(args.password_file).read_text(encoding="utf-8").strip()
    else:
        password = os.environ.get("SSH_ROOT_PASSWORD", "")
    if not password:
        return fail("пароль не задан: SSH_ROOT_PASSWORD или --password-file")

    home = "/root" if args.user == "root" else f"/home/{args.user}"
    ak = f"{home}/.ssh/authorized_keys"

    # --- запись в known_hosts после переустановки протухает --------------------
    if not args.keep_host_key and KNOWN_HOSTS.is_file():
        subprocess.run(
            ["ssh-keygen", "-f", str(KNOWN_HOSTS), "-R", args.host],
            capture_output=True,
            check=False,
        )
        print(f"[known_hosts] старая запись для {args.host} удалена")

    # --- шаг 1: вход по паролю -------------------------------------------------
    # Соединение поднимается через Transport, а не SSHClient.connect: тот
    # отправляет пароль внутри одного вызова, и сверить отпечаток хоста ДО
    # передачи пароля уже невозможно. Здесь рукопожатие и аутентификация
    # разделены, и между ними стоит проверка.
    transport = paramiko.Transport((args.host, args.port))
    transport.start_client(timeout=25)
    hk = transport.get_remote_server_key()
    fp = "SHA256:" + base64.b64encode(hashlib.sha256(hk.asbytes()).digest()).decode().rstrip("=")

    if args.expect_host_key:
        expected = args.expect_host_key.strip()
        if not expected.startswith("SHA256:"):
            expected = "SHA256:" + expected
        if expected != fp:
            transport.close()
            return fail(
                f"отпечаток хоста не совпал: ждали {expected}, получили {fp}. "
                "Пароль НЕ передан. Либо сервер переустановили, либо соединение "
                "перехватывают — выясни, какое из двух, прежде чем повторять"
            )
        print(f"[хост] {hk.get_name()} {fp} — совпал с ожидаемым")
    else:
        print(f"[хост] {hk.get_name()} {fp}  <- сверь с панелью хостера")

    try:
        transport.auth_password(args.user, password)
    except paramiko.AuthenticationException:
        transport.close()
        return fail(
            f"пароль для {args.user}@{args.host} не подошёл. Значение НЕ печатается; "
            "проверь SSH_ROOT_PASSWORD или --password-file"
        )

    print("[сервер]", " | ".join(run(transport, "hostname; . /etc/os-release && echo $PRETTY_NAME").split()))

    # --- шаг 2: правка authorized_keys через SFTP ------------------------------
    sftp = paramiko.SFTPClient.from_transport(transport)
    for path, mode in ((f"{home}/.ssh", 0o700),):
        try:
            sftp.stat(path)
        except IOError:
            sftp.mkdir(path, mode)
            print(f"[создан] {path}")
        sftp.chmod(path, mode)

    try:
        with sftp.open(ak, "r") as f:
            existing = f.read().decode("utf-8", errors="replace")
    except IOError:
        existing = ""

    lines = [ln.strip() for ln in existing.split("\n") if ln.strip()]
    foreign = [ln for ln in lines if not (len(ln.split()) >= 2 and ln.split()[1] == blob)]
    print(f"[было] строк: {len(lines)}, из них чужих: {len(foreign)}")
    for ln in foreign:
        print(f"        чужой ключ сохраняется: ...{ln.split()[-1]}")

    # Наш ключ всегда ровно один и всегда последней строкой — вне зависимости от
    # того, был он там раньше или нет; различается только сообщение.
    result = foreign + [pub]
    if len(foreign) == len(lines):
        print("[действие] наш ключ дописан")
    else:
        print("[действие] наш ключ уже был — строка перезаписана без дублирования")

    with sftp.open(ak, "w") as f:
        f.write(("\n".join(result) + "\n").encode("utf-8"))
    sftp.chmod(ak, 0o600)

    with sftp.open(ak, "r") as f:
        after = f.read().decode("utf-8", errors="replace")
    print(f"[стало] строк: {len([l for l in after.split(chr(10)) if l.strip()])}, "
          f"права: {oct(stat.S_IMODE(sftp.stat(ak).st_mode))}")
    sftp.close()
    transport.close()

    if blob not in after:
        return fail("после записи нашего ключа в файле нет")

    # --- шаг 3: проверка входа ТОЛЬКО по ключу ---------------------------------
    print("\n[проверка] вход по ключу, пароль не передаётся")
    key_class = KEY_CLASSES.get(parts[0])
    if key_class is None:
        return fail(f"неизвестный тип ключа {parts[0]}; известны: {', '.join(KEY_CLASSES)}")
    try:
        key = key_class.from_private_key_file(str(priv_path))
    except paramiko.PasswordRequiredException:
        return fail(
            f"{priv_path} защищён парольной фразой — неинтерактивная проверка входа "
            "невозможна. Ключ в authorized_keys УЖЕ записан (шаг 2 прошёл); "
            "проверь вход вручную: "
            f"ssh -i {priv_path} -o IdentitiesOnly=yes {args.user}@{args.host}"
        )
    c2 = paramiko.SSHClient()
    c2.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c2.connect(
        args.host,
        port=args.port,
        username=args.user,
        pkey=key,
        timeout=25,
        allow_agent=False,
        look_for_keys=False,
    )
    _, out, _ = c2.exec_command("id; hostname; date -u +%Y-%m-%dT%H:%M:%SZ")
    out.channel.recv_exit_status()
    print(out.read().decode(errors="replace").strip())
    c2.close()
    print("\nРЕЗУЛЬТАТ: вход по ключу выполнен")
    print(f"Дальше: ssh -i {priv_path.relative_to(ROOT)} -o IdentitiesOnly=yes "
          f"{args.user}@{args.host}")
    return 0


def fail(msg: str) -> int:
    print(f"ОШИБКА: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
