"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  NAVIGATION_SECTIONS,
  isNavigationLinkActive,
} from "@/lib/navigation";

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="주 메뉴" className="flex flex-col gap-5">
      {NAVIGATION_SECTIONS.map((section) => {
        const headingId = `nav-section-${section.key}`;
        return (
          <div key={section.key} role="group" aria-labelledby={headingId}>
            <h2
              id={headingId}
              className="mb-1 px-3 text-[11px] font-semibold tracking-wide text-neutral-400"
            >
              {section.label}
            </h2>
            <div className="flex flex-col gap-0.5">
              {section.links.map((link) => {
                const active = isNavigationLinkActive(pathname, link);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={`rounded px-3 py-2 text-sm font-medium transition ${
                      active
                        ? "bg-neutral-900 text-white"
                        : "text-neutral-600 hover:bg-neutral-100"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
