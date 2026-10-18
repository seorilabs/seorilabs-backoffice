import type { StoreReviewStore } from "@prisma/client";

export interface StoreReviewCollectOptions {
  appSlug?: string;
  store?: StoreReviewStore;
  notifyReviewIds?: string[];
}

export function validateReviewOptions(options: StoreReviewCollectOptions): void {
  if (options.appSlug !== undefined && !options.appSlug.trim()) {
    throw new Error("앱 slug가 비어 있습니다");
  }
  if (options.store !== undefined && !["GOOGLE_PLAY", "APP_STORE"].includes(options.store)) {
    throw new Error("마켓은 GOOGLE_PLAY 또는 APP_STORE여야 합니다");
  }
  if (options.notifyReviewIds !== undefined) {
    if (!options.appSlug || !options.store) throw new Error("리뷰 복구에는 앱과 마켓을 모두 지정해야 합니다");
    if (!options.notifyReviewIds.length || options.notifyReviewIds.some((id) => !id.trim())) {
      throw new Error("복구 리뷰 ID가 비어 있습니다");
    }
  }
}

export function parseReviewOptions(args: string[]): StoreReviewCollectOptions {
  const options: StoreReviewCollectOptions = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!["--app", "--store", "--notify-review"].includes(flag ?? "")) {
      throw new Error(`알 수 없는 인자: ${flag}`);
    }
    if (!value?.trim() || value.startsWith("--")) throw new Error(`${flag} 값이 필요합니다`);
    if (flag === "--notify-review") {
      (options.notifyReviewIds ??= []).push(value);
    } else if (flag === "--app") {
      if (options.appSlug !== undefined) throw new Error("--app 중복 지정");
      options.appSlug = value;
    } else {
      if (options.store !== undefined) throw new Error("--store 중복 지정");
      options.store = value as StoreReviewStore;
    }
  }
  validateReviewOptions(options);
  return options;
}
