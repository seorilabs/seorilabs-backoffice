export interface PlatformAppBinding {
  slug: string;
  platformAppId: string | null;
}

/** 저장소 slug와 Platform registry app_id가 다른 앱도 같은 운영 계약으로 묶는다. */
export function resolvedPlatformAppId(app: PlatformAppBinding): string {
  return app.platformAppId?.trim() || app.slug;
}
