import Ajv2020 from "ajv/dist/2020";
import { parse } from "yaml";
import { createHash } from "node:crypto";
import { getInstallationOctokit } from "@/lib/github/app";
import { getRepoTextFile } from "@/lib/github/read";
import type { RegistrationPolicy } from "./contracts";
let cached: { value: RegistrationPolicy; at: number } | undefined;
/** 최신 기본 브랜치의 exact SHA에서 계약·스키마·등록 문서를 함께 확인한다. 실패 시 등록하지 않는다. */
export async function loadRegistrationPolicy(fresh = false): Promise<RegistrationPolicy> {
  if (!fresh && cached && Date.now() - cached.at < 15 * 60_000) return cached.value;
  const client = await getInstallationOctokit(), identity = { owner: "seorilabs", repo: ".github" };
  const repo = (await client.rest.repos.get(identity)).data;
  const sha = (await client.rest.repos.getCommit({ ...identity, ref: repo.default_branch })).data.sha;
  const [yaml, schemaText, document] = await Promise.all([
    getRepoTextFile("seorilabs/.github", "contracts/autonomous-issue-policy.yaml", sha),
    getRepoTextFile("seorilabs/.github", "contracts/autonomous-issue-policy.schema.json", sha),
    getRepoTextFile("seorilabs/.github", "docs/agent-governance/autonomous-issue-registration.md", sha),
  ]);
  if (!yaml || !schemaText || !document) throw new Error("REGISTRATION_POLICY_UNAVAILABLE");
  const value = parse(yaml), validate = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(schemaText));
  if (!validate(value)) throw new Error("REGISTRATION_POLICY_INVALID");
  const validated = value as RegistrationPolicy["data"] & { schemaVersion: number; schedules: { registration: { maxConcurrentCreates: number; maxAttemptsPerCandidatePerRun: number } } };
  if (validated.schedules.timezone !== "Asia/Seoul" || validated.schemaVersion !== 4 || validated.schedules.registration.mode !== "evidence-batch" || validated.schedules.registration.maxConcurrentCreates !== 1 || validated.schedules.registration.maxAttemptsPerCandidatePerRun !== 1) throw new Error("REGISTRATION_POLICY_INVALID");
  const result: RegistrationPolicy = { sha, documentHash: createHash("sha256").update(document).digest("hex"), data: validated };
  cached = { value: result, at: Date.now() };
  return result;
}
