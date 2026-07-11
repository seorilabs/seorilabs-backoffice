"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Nav } from "@/components/Nav";

export function AppShell({
  userLabel,
  signOut,
  children,
}: {
  userLabel: string;
  signOut: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // 라우트 변경 시 모바일 드로어 닫기
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 드로어 열림 동안 본문 스크롤 잠금
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open]);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* 모바일 상단바 */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="메뉴 열기"
          aria-expanded={open}
          className="-ml-1 flex h-9 w-9 items-center justify-center rounded-md text-neutral-700 hover:bg-neutral-100"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Seorilabs</div>
          <div className="text-[11px] text-neutral-500">제작 공장 백오피스</div>
        </div>
      </header>

      {/* 모바일 백드롭 */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          aria-hidden
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
        />
      )}

      {/* 사이드바 — 모바일: 슬라이드 드로어 / 데스크톱: 고정 */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 max-w-[80vw] shrink-0 flex-col border-r border-neutral-200 bg-white p-4 transition-transform duration-200 ease-out md:static md:z-auto md:w-60 md:max-w-none md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-start justify-between px-2 pb-4">
          <div>
            <div className="text-sm font-semibold">Seorilabs</div>
            <div className="text-xs text-neutral-500">제작 공장 백오피스</div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="메뉴 닫기"
            className="-mr-1 flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 md:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <Nav />
        <div className="mt-auto flex items-center justify-between px-2 pt-4">
          <span className="truncate text-xs text-neutral-500">@{userLabel}</span>
          {signOut}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-x-hidden bg-neutral-50">{children}</main>
    </div>
  );
}
