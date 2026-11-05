# Плановая смена версии ключа: новая версия и переупаковка записей. Ключ наружу не выдаётся.
# Ключ поиска намеренно не указан: его новая версия требует пересчёта индексов.
# Токен с этой политикой выдаётся на время работы, ядру она не нужна.
path "transit/keys/prod-*" {
  capabilities = ["read"]
}
path "transit/keys/prod-passport-sensitive/rotate" {
  capabilities = ["update"]
}
path "transit/keys/prod-kyb-documents/rotate" {
  capabilities = ["update"]
}
path "transit/keys/prod-kyc-documents/rotate" {
  capabilities = ["update"]
}
path "transit/keys/prod-webhook-secrets/rotate" {
  capabilities = ["update"]
}
path "transit/encrypt/prod-*" {
  capabilities = ["update"]
}
path "transit/decrypt/prod-*" {
  capabilities = ["update"]
}
