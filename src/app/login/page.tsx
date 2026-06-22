import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { SignInButton } from "@/components/AuthButtons";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");
  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold">Seorilabs Backoffice</h1>
        <p className="mt-1 mb-6 text-sm text-neutral-500">
          앱 제작 공장 라이프사이클 워크플로우
        </p>
        {error === "AccessDenied" || error === "not-allowed" ? (
          <p className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-600">
            허용되지 않은 계정입니다. 관리자에게 allowlist 등록을 요청하세요.
          </p>
        ) : null}
        <div className="flex justify-center">
          <SignInButton />
        </div>
      </div>
    </main>
  );
}
