import { redirect } from "next/navigation";
export default async function Redirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams(); for (const [key, value] of Object.entries(await searchParams)) { if (typeof value === "string") query.set(key, value); }
  redirect(`/work/board${query.size ? `?${query}` : ""}`);
}
