#!/bin/bash
# Что на самом деле работает на test-2. Только чтение.
docker inspect fifth-test-2-core --format '{{.Config.Image}} {{.Image}}' | cut -c1-90
docker exec fifth-test-2-core sh -c 'grep -l MAIL_SUBJECT_PREFIX apps/core/dist/comms/mail.transport.js apps/core/dist/config/env.js; echo "GIT=$GIT_COMMIT"; cat apps/core/dist/version.json 2>/dev/null | cut -c1-80'
grep -cE '^MAIL_SUBJECT_PREFIX' /opt/fifth-element/.local/envs/test-2/settings.env
docker inspect fifth-test-2-core --format 'mem {{.HostConfig.Memory}} cpu {{.HostConfig.NanoCpus}}'
id="$(grep 'no-reply-test-2' /var/log/exim4/mainlog | tail -1 | awk '{print $3}')"
grep "$id" /var/log/exim4/mainlog | sed -E 's/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/***@\1/g' | cut -c1-170 | tail -4
