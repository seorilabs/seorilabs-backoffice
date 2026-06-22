import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Seorilabs Backoffice",
  description: "앱 제작 공장 라이프사이클 워크플로우 백오피스",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
