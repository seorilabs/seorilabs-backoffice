import { FeedbackView } from "@/components/insights/FeedbackView";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <FeedbackView appId={(await params).id} />;
}
