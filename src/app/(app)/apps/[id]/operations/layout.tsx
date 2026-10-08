import { OperationsNav } from "@/components/insights/OperationsNav";
export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const base = "/apps/" + (await params).id + "/operations";
  return (
    <>
      <OperationsNav base={base} />
      {children}
    </>
  );
}
