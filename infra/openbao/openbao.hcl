# OpenBao рабочей площадки (блок 5, задание 3). Один узел, Raft, без dev-режима.
# Файл без значений: ключ и сертификат подключаются только для чтения.
ui = false
disable_mlock = true
api_addr = "https://127.0.0.1:8200"
cluster_addr = "https://127.0.0.1:8201"

storage "raft" {
  path = "/openbao/data"
  node_id = "fifth-1"
}

listener "tcp" {
  address = "0.0.0.0:8200"
  tls_cert_file = "/openbao/tls/tls.crt"
  tls_key_file = "/openbao/tls/tls.key"
}

# В этой версии аудит задаётся только здесь: через API его не включить и не отключить.
audit "file" "main" {
  options {
    file_path = "/openbao/audit/audit.log"
  }
}

seal "static" {
  current_key_id = "fifth-1"
  current_key = "file:///openbao/seal/static.key"
}
