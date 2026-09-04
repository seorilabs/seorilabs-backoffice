const REPOSITORY_ID = /^[1-9][0-9]{0,31}$/u;
const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

type RepositoryBinding = {
  id: string;
  fullName: string;
  sourceSha: string;
};

type ProofBinding = {
  repositoryId: string;
  repositoryFullName: string;
  sourceSha: string;
  proofDigest: string;
};

function fail(): never {
  throw new Error("FLEET_MIGRATION_RUNTIME_PROOF_COVERAGE_INVALID");
}

export function resolveFleetMigrationApprovedProofDigests(input: {
  repositories: readonly RepositoryBinding[];
  proofs: readonly ProofBinding[];
}): string[] {
  if (input.repositories.length < 1 || input.repositories.length > 500) fail();
  const cohort = new Map<string, RepositoryBinding>();
  const names = new Set<string>();
  for (const repository of input.repositories) {
    const normalizedName = repository.fullName.toLowerCase();
    if (
      !REPOSITORY_ID.test(repository.id)
      || !REPOSITORY.test(repository.fullName)
      || !SHA.test(repository.sourceSha)
      || cohort.has(repository.id)
      || names.has(normalizedName)
    ) fail();
    cohort.set(repository.id, repository);
    names.add(normalizedName);
  }

  const covered = new Set<string>();
  const digests = new Set<string>();
  for (const proof of input.proofs) {
    const repository = cohort.get(proof.repositoryId);
    if (
      !repository
      || repository.fullName !== proof.repositoryFullName
      || repository.sourceSha !== proof.sourceSha
      || !SHA256.test(proof.proofDigest)
    ) fail();
    covered.add(proof.repositoryId);
    digests.add(proof.proofDigest);
  }
  if (covered.size !== cohort.size) fail();
  return [...digests].sort();
}
