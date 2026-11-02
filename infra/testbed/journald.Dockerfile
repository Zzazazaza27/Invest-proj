# Испытательный стенд архиватора журналов (2.1-W08b): настоящий systemd-journald
# и Node 22 в одном контейнере. Только для локальных испытаний
# (scripts/check-logs-archive.mjs); на серверы не выкладывается.
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/log/journal
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
