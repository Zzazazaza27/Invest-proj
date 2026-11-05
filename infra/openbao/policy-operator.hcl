# Личный вход Томаса: повседневное управление вместо начального root-токена.
path "*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}
