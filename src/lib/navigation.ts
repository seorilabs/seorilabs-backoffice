export type NavigationMatch = "exact" | "nested";

export interface NavigationLink {
  href: string;
  label: string;
  match: NavigationMatch;
}

export interface NavigationSection {
  key: "platform" | "apps";
  label: string;
  links: readonly NavigationLink[];
}

export const NAVIGATION_SECTIONS: readonly NavigationSection[] = [
  {
    key: "platform",
    label: "플랫폼",
    links: [
      { href: "/platform", label: "개요", match: "exact" },
      { href: "/platform/auth", label: "인증", match: "nested" },
      { href: "/platform/iap", label: "IAP", match: "nested" },
    ],
  },
  {
    key: "apps",
    label: "앱",
    links: [
      { href: "/", label: "대시보드", match: "exact" },
      { href: "/board", label: "워크플로우 보드", match: "nested" },
      { href: "/analytics", label: "지표", match: "nested" },
      { href: "/issues", label: "이슈", match: "nested" },
      { href: "/approvals", label: "승인 대기", match: "nested" },
      { href: "/releases", label: "출시 매트릭스", match: "nested" },
      { href: "/release-notes", label: "출시노트", match: "nested" },
      { href: "/plan", label: "기획 입력", match: "nested" },
      { href: "/settings", label: "설정", match: "nested" },
    ],
  },
] as const;

/**
 * 경로 세그먼트 경계를 포함해 활성 링크를 판정한다.
 *
 * `startsWith`만 쓰면 `/platform/iap-old`도 IAP로 표시되고,
 * `/platform/iap`에서 플랫폼 개요까지 동시에 활성화된다.
 */
export function isNavigationLinkActive(
  pathname: string,
  link: NavigationLink,
): boolean {
  if (pathname === link.href) return true;
  return link.match === "nested" && pathname.startsWith(`${link.href}/`);
}
