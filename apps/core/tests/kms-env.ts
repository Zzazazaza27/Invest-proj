/** Рабочий режим ключей в проверках настроек: OpenBao задан, KEK в окружении нет. */
export const KMS_ENV: NodeJS.ProcessEnv = {
  KMS_MODE: 'kms',
  OPENBAO_ADDR: 'https://127.0.0.1:8200',
  OPENBAO_CA_PATH: '/run/fifth-secrets/openbao-ca.crt',
  OPENBAO_TOKEN_PATH: '/run/fifth-secrets/openbao-token',
  KEK_SEARCH_INDEX: '',
  KEK_KYC_DOCUMENTS: '',
  KEK_KYB_DOCUMENTS: '',
  KEK_PASSPORT_SENSITIVE: '',
  KEK_WEBHOOK_SECRETS: '',
};
