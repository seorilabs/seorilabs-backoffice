import { PlatformAuthLookup } from "@/components/platform";

export const dynamic = "force-dynamic";

export default function PlatformAuthPage() {
  return (
    <section className="max-w-4xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900">인증 사용자</h2>
        <p className="mt-1 text-sm text-neutral-500">
          이메일·이름·토큰 없이 운영용 식별자와 익명 여부만 확인합니다.
        </p>
      </div>
      <PlatformAuthLookup />
    </section>
  );
}
