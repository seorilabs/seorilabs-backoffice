import { z } from "zod";

const url = z.string().url().max(3000).refine(value => /^https?:\/\//i.test(value), "HTTP 링크가 필요합니다");
const short = z.string().trim().min(1).max(1000);
export const presentationSchema = z.object({
  layout: z.enum(["card", "newsletter"]).optional(),
  title: short,
  status: z.enum(["success", "warning", "failure", "info"]).optional(),
  body: z.string().max(100_000).optional(),
  fields: z.array(z.object({label:short,value:z.union([z.string().max(4000),z.number().finite(),z.null()])}).strict()).max(30).optional(),
  sections: z.array(z.object({title:short.optional(),body:z.string().max(100_000)}).strict()).max(50).optional(),
  items: z.array(z.object({title:short,summary:z.string().max(16000),url}).strict()).max(100).optional(),
  links: z.array(z.object({label:short,url}).strict()).max(20).optional(),
  context: z.array(z.string().max(1500)).max(8).optional(),
  timestamp: z.string().datetime({offset:true}).optional(),
}).strict();
export type MessagePresentation = z.infer<typeof presentationSchema>;

export function storedPresentation(value: unknown): MessagePresentation | undefined {
  const result = presentationSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function presentationTime(value?: string): string | undefined {
  if (!value || Number.isNaN(Date.parse(value))) return;
  return new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(value)) + " KST";
}
