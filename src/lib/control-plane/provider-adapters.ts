/** Auth Broker와 provider executor가 공유하는 고정 adapter ID 계약. */
export const PROVIDER_ADAPTER_IDS = {
  GCP_PROVISIONER: "gcp-provisioner-v1",
  FIREBASE_PROVISIONER: "firebase-provisioner-v1",
  WORKSPACE_PROVISIONER: "workspace-provisioner-v1",
  GOOGLE_PLAY: "google-play-api-v1",
  APP_STORE_CONNECT: "app-store-connect-api-v1",
  APPS_IN_TOSS: "ait-cli-v1",
} as const;

export type ProviderAdapterId = typeof PROVIDER_ADAPTER_IDS[keyof typeof PROVIDER_ADAPTER_IDS];
