# Agent ядра (блок 5, задание 3): вход по AppRole, секреты файлами в памяти.
# Имена файлов те же, что в `<ИМЯ>_FILE`, поэтому потребители не меняются.
# Список шаблонов для всех секретов собирается в задании 5.
vault {
  address = "https://127.0.0.1:8200"
  ca_cert = "/openbao/tls/tls.crt"
}

auto_auth {
  method "approle" {
    config = {
      role_id_file_path = "/agent/role-id"
      secret_id_file_path = "/agent/secret-id"
      remove_secret_id_file_after_reading = false
    }
  }

  # Токен для Transit: ядро читает файл на каждый вызов, Agent его продлевает.
  sink "file" {
    config = {
      path = "/run/fifth-secrets/openbao-token"
      mode = 0440
    }
  }
}

template_config {
  static_secret_render_interval = "5m"
  exit_on_retry_failure = false
}

template {
  contents = "{{ with secret \"kv/data/prod/core/POSTGRES_PASSWORD\" }}{{ .Data.data.value }}{{ end }}"
  destination = "/run/fifth-secrets/POSTGRES_PASSWORD"
  perms = "0440"
}
