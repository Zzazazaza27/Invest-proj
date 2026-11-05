#!/bin/bash
# Блок 5, шаг 3.0. Запускает Томас: sudo bash infra/host/apply-access-narrowing.sh
# Значения не печатаются. Повторный запуск безопасен.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" -eq 0 ] || { echo 'запускать через sudo'; exit 1; }
[ "$(passwd -S thomas | awk '{print $2}')" = P ] || {
  echo 'у thomas нет пароля: сначала sudo passwd thomas'
  exit 1
}

install -o root -g root -m 755 fifth-backup-read fifth-diag /usr/local/sbin/
visudo -cf sudoers-maus

apt-get install -y -q fail2ban >/dev/null
install -o root -g root -m 644 fail2ban-sshd.conf /etc/fail2ban/jail.d/fifth-sshd.conf
systemctl enable --now fail2ban >/dev/null 2>&1
systemctl restart fail2ban

install -o root -g root -m 440 sudoers-maus /etc/sudoers.d/90-maus
usermod -aG systemd-journal maus
gpasswd -d maus sudo >/dev/null 2>&1 || true
rm -f /etc/sudoers.d/90-thomas

echo '== maus'
id maus
sudo -l -U maus | tail -3
echo '== thomas'
sudo -l -U thomas | tail -2
echo '== fail2ban'
sleep 2
fail2ban-client status sshd | sed -n 1,4p
