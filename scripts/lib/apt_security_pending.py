#!/usr/bin/env python3
"""Обновления безопасности, которые ждут установки (Тэнк 16.11), — для monitor-host-env.mjs.

Считаются только УСТАНОВЛЕННЫЕ пакеты, у которых в источнике безопасности есть версия новее
установленной. apt-check Ubuntu считает иначе: моделирует полный dist-upgrade и засчитывает
новые пакеты-зависимости обновлений из -updates (16.11: linux-firmware-amd-graphics,
libabsl20220623t64), — unattended-upgrades их и не должен ставить.

Причина задержки, если она согласована, указывается отдельно:
  hold      — apt-mark hold;
  blacklist — Unattended-Upgrade::Package-Blacklist;
  pin       — закрепление apt: кандидат ниже версии из источника безопасности.
Без причины — пакет обязан встать штатным запуском; иначе тревога.

Вывод — JSON в stdout: {"pending": [{name, installed, security, candidate, origin, reason}]}.
Только чтение: кеш списков apt, ничего не обновляется и не ставится.
"""
import json
import re

import apt_pkg

apt_pkg.init()
cache = apt_pkg.Cache(None)
policy = apt_pkg.Policy(cache)
policy.init_defaults()
policy.read_pinfile(apt_pkg.config.find_file("Dir::Etc::Preferences"))
policy.read_pindir(apt_pkg.config.find_dir("Dir::Etc::PreferencesParts"))
blacklist = apt_pkg.config.value_list("Unattended-Upgrade::Package-Blacklist")


def security_origin(ver):
    for f, _ in ver.file_list:
        if f.archive.endswith("-security") and (f.origin or "").startswith("Ubuntu"):
            return f"{f.origin}:{f.archive}/{f.component}"
    return None


def blacklisted(name):
    # unattended-upgrades сопоставляет записи как регулярные выражения с начала имени.
    for b in blacklist:
        try:
            if re.match(b, name):
                return True
        except re.error:
            if b == name:
                return True
    return False


pending = []
for pkg in cache.packages:
    cur = pkg.current_ver
    if not cur:
        continue
    newer = [
        v
        for v in pkg.version_list
        if apt_pkg.version_compare(v.ver_str, cur.ver_str) > 0 and security_origin(v)
    ]
    if not newer:
        continue
    # Наибольшая версия по правилам dpkg, а не по строке.
    sec = newer[0]
    for v in newer[1:]:
        if apt_pkg.version_compare(v.ver_str, sec.ver_str) > 0:
            sec = v
    cand = policy.get_candidate_ver(pkg)
    name = pkg.get_fullname(True)
    if pkg.selected_state == apt_pkg.SELSTATE_HOLD:
        reason = "hold"
    elif blacklisted(pkg.name):
        reason = "blacklist"
    elif not cand or apt_pkg.version_compare(cand.ver_str, sec.ver_str) < 0:
        reason = "pin"
    else:
        reason = None
    pending.append(
        {
            "name": name,
            "installed": cur.ver_str,
            "security": sec.ver_str,
            "candidate": cand.ver_str if cand else None,
            "origin": security_origin(sec),
            "reason": reason,
        }
    )

print(json.dumps({"pending": sorted(pending, key=lambda p: p["name"])}))
