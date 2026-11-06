#!/bin/bash
# Откуда взялся материал без файла. Только чтение, значений не печатает.
set -uo pipefail
ID="$1"
url="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' /run/fifth-secrets/DATABASE_URL_OWNER)"
q() { docker exec -e URL="$url" fifth-postgres sh -c "psql \"\$URL\" -At -F' | ' -c \"$1\""; }
q "SELECT m.type, m.upload_state, m.uploaded_at::timestamp(0), m.uploaded_by, p.created_at::timestamp(0) FROM lab.project_materials m JOIN lab.projects p ON p.id = m.project_id WHERE m.id = '$ID'"
q "SELECT (to_jsonb(a) - 'final_key' - 'lease_id')::text FROM lab.material_upload_attempts a WHERE material_id = '$ID'" 2>&1 | cut -c1-300
q "SELECT ts::timestamp(0), verb FROM audit.events WHERE subject_id::text IN ('$ID', (SELECT project_id::text FROM lab.project_materials WHERE id = '$ID')) ORDER BY ts LIMIT 12" 2>&1 | cut -c1-160
q "SELECT primary_role, status, created_at::timestamp(0) FROM identity.users WHERE id = (SELECT uploaded_by FROM lab.project_materials WHERE id = '$ID')" 2>&1 | cut -c1-120
q "SELECT (SELECT count(*) FROM lab.project_materials WHERE upload_state = 'ready' AND s3_key LIKE 'projects/%')" 2>&1
