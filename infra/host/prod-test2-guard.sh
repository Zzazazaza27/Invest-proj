#!/bin/bash
# Пилотную среду не останавливает и не удаляет обычная команда.
cd /opt/fifth-element
node scripts/env.mjs stop test-2 | cut -c1-120
node scripts/env.mjs destroy test-2 --confirm test-2 | cut -c1-120
node scripts/env.mjs status test-2 --text | tail -1
