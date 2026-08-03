export const BUILD_TARGETS = ["AIT", "ANDROID"] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

export interface BuildTargetDefinition {
  workflowFile: string;
  label: string;
  artifact: string;
}

export const BUILD_TARGET_DEFINITIONS: Record<BuildTarget, BuildTargetDefinition> = {
  AIT: {
    workflowFile: "build-ait.yml",
    label: "AIT 후보 빌드",
    artifact: ".ait",
  },
  ANDROID: {
    workflowFile: "build-android.yml",
    label: "Android 후보 빌드",
    artifact: "signed AAB",
  },
};

export function isBuildTarget(value: string): value is BuildTarget {
  return (BUILD_TARGETS as readonly string[]).includes(value);
}

export function buildTargetsFromWorkflowFiles(
  workflowFiles: Iterable<string>,
): BuildTarget[] {
  const files = new Set(workflowFiles);
  return BUILD_TARGETS.filter((target) =>
    files.has(BUILD_TARGET_DEFINITIONS[target].workflowFile),
  );
}

export function buildDispatchRequest(target: BuildTarget, releaseTag: string): {
  workflowFile: string;
  inputs: Record<string, string>;
} {
  return {
    workflowFile: BUILD_TARGET_DEFINITIONS[target].workflowFile,
    inputs: { release_tag: releaseTag },
  };
}
