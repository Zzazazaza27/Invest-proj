#!/bin/bash
# Какие образы заданы среде test-2. Только чтение.
grep -E '^FIFTH_(CORE|WEB|POSTGRES)_IMAGE=' /opt/fifth-element/.local/envs/test-2/compose.env
grep -E '"label"' /opt/fifth-element/.local/envs/test-2/install.json
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -E 'fifth/core:2.1-b12' | cut -c1-60
sed -n 's/^FIFTH_CORE_IMAGE=/.env: /p' /opt/fifth-element/.env
