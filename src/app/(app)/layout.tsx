import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/AuthButtons";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <AppShell
      userLabel={session.user.login ?? session.user.name ?? "user"}
      signOut={<SignOutButton />}
    >
      {children}
    </AppShell>
  );
}
