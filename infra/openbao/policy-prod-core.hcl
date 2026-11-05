# Ядро рабочей среды: только свои секреты и криптографические операции.
# Ключи, политики и аудит ему недоступны.
path "kv/data/prod/core/*" {
  capabilities = ["read"]
}
path "transit/encrypt/prod-*" {
  capabilities = ["update"]
}
path "transit/decrypt/prod-*" {
  capabilities = ["update"]
}
path "transit/hmac/prod-*" {
  capabilities = ["update"]
}
