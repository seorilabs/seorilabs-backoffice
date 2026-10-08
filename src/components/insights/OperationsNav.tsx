"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
export function OperationsNav({ base }: { base: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="운영 도구" className="mb-5 flex flex-wrap gap-2">
      {[
        ["", "운영 작업"],
        ["commerce", "앱 내 결제"],
        ["ads", "광고"],
        ["content", "콘텐츠"],
        ["flags", "기능 켜기·끄기"],
      ].map(([key, label]) => {
        const href = key ? base + "/" + key : base,
          active = pathname === href;
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={
              "rounded border px-3 py-2 text-sm " +
              (active ? "border-blue-700 bg-blue-50 text-blue-700" : "bg-white")
            }
            key={key}
            href={href}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
