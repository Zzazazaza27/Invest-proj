# Испытательный стенд применения W08b: systemd-journald, Node 22 и свой
# Docker Engine внутри — драйвер журналов journald и остановка контейнера
# проверяются по-настоящему (Docker Desktop journald не поддерживает).
# Только для локальных испытаний (scripts/check-logs-apply.mjs).
FROM fifth/journald-testbed:local
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /etc/docker \
 && printf '{"storage-driver":"vfs"}\n' > /etc/docker/daemon.json
