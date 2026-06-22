import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 단일 컨테이너 배포용. .next/standalone 산출.
  output: "standalone",
  experimental: {
    // server action 본문 크기(기획 입력 폼 등)
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
