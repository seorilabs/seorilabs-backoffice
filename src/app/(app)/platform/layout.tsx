import Link from "next/link";

const links = [
  { href: "/platform", label: "개요" },
  { href: "/platform/auth", label: "인증" },
  { href: "/platform/iap", label: "IAP" },
  { href: "/platform/ads", label: "Ads" },
] as const;

export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-6 sm:p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-semibold tracking-wide text-neutral-400">
            PLATFORM
          </div>
          <h1 className="mt-1 text-xl font-semibold text-neutral-900">
            공통 플랫폼 관리
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            앱별 화면과 분리된 인증·IAP·광고 공통 기능을 관리합니다.
          </p>
        </div>
        <nav aria-label="플랫폼 관리" className="flex gap-1 rounded-lg bg-neutral-100 p-1">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-white hover:text-neutral-900"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
