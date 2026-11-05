# Копии: только снимок. Секреты снимок отдаёт зашифрованными, без Static seal key он не читается.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
