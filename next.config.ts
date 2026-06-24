import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 단일 컨테이너 배포용. .next/standalone 산출.
  output: "standalone",
  // lint/typecheck 는 CI verify 잡에서 이미 수행 → 빌드 시 중복 제거(빌드 단축).
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  experimental: {
    // server action 본문 크기(기획 입력 폼 등)
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
