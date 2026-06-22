import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Nav } from "@/components/Nav";
import { SignOutButton } from "@/components/AuthButtons";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-white p-4">
        <div className="px-2 pb-4">
          <div className="text-sm font-semibold">Seorilabs</div>
          <div className="text-xs text-neutral-500">제작 공장 백오피스</div>
        </div>
        <Nav />
        <div className="mt-auto flex items-center justify-between px-2 pt-4">
          <span className="truncate text-xs text-neutral-500">
            @{session.user.login ?? session.user.name}
          </span>
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden bg-neutral-50">{children}</main>
    </div>
  );
}
