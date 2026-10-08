import { redirect } from "next/navigation";
export default async function Redirect({ params }: { params: Promise<{ id: string }> }) { redirect(`/apps/${(await params).id}/operations/flags`); }
