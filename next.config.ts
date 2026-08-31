import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // repo-contract의 fleet validator는 import.meta.url 기준으로 패키지에 동봉된 JSON schema를
  // 런타임 로드한다. webpack이 이를 client-style로 번들하면 존재하지 않는 source checkout
  // fallback까지 정적 resolve하므로 server package 그대로 standalone trace에 포함한다.
  serverExternalPackages: ["seorilabs-org-contracts"],
  // 단일 컨테이너 배포용. .next/standalone 산출.
  output: "standalone",
  // sharp 를 standalone 트레이스에서 제외한다. 이 앱은 next/image 를 쓰지 않고,
  // sharp 는 Next 의 optional 전이 의존이라 빌드 호스트 아키텍처의 바이너리가
  // 딸려 들어온다. 제외하면 산출물이 순수 JS + 명시된 Prisma arm64 엔진만 남아
  // 빌드 호스트와 무관해진다(amd64 러너에서 arm64 이미지 크로스빌드).
  outputFileTracingExcludes: {
    "*": ["**/@img/**", "**/sharp/**"],
  },
  // lint/typecheck 는 CI verify 잡에서 이미 수행 → 빌드 시 중복 제거(빌드 단축).
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  experimental: {
    // server action 본문 크기(기획 입력 폼 등)
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
