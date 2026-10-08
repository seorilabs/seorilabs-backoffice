export type NavigationMatch = "exact" | "nested";
export interface NavigationLink { href: string; label: string; match: NavigationMatch; }
export interface NavigationSection { key: "operations"; label: string; links: readonly NavigationLink[]; }
export const NAVIGATION_SECTIONS: readonly NavigationSection[] = [{ key: "operations", label: "운영", links: [
  { href: "/", label: "종합 현황", match: "exact" },
  { href: "/apps", label: "앱", match: "nested" },
  { href: "/analytics", label: "지표 분석", match: "nested" },
  { href: "/work", label: "해야 할 일", match: "nested" },
  { href: "/releases", label: "출시", match: "nested" },
  { href: "/feedback", label: "피드백·시장", match: "nested" },
  { href: "/platform", label: "플랫폼", match: "nested" },
  { href: "/settings", label: "설정", match: "nested" },
] }];
export function isNavigationLinkActive(pathname: string, link: NavigationLink): boolean {
  return pathname === link.href || (link.match === "nested" && pathname.startsWith(`${link.href}/`));
}
