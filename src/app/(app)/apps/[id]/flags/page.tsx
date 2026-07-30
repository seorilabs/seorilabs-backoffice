import { AppToolPage } from "@/components/app-ops/AppToolPage";

export default async function FlagsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AppToolPage appId={id} section="flags" />;
}
