import { parse as parseYaml } from "yaml";

export interface WorkflowDispatchContract {
  dispatchable: boolean;
  inputNames: Set<string>;
}

export function parseWorkflowDispatchContract(text: string): WorkflowDispatchContract {
  const doc = parseYaml(text) as
    | { on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } | null } }
    | null;
  const triggers = doc?.on;
  const dispatchable = Boolean(
    triggers && Object.prototype.hasOwnProperty.call(triggers, "workflow_dispatch"),
  );
  const dispatch = triggers?.workflow_dispatch;
  const inputs = dispatch && typeof dispatch === "object" ? dispatch.inputs ?? {} : {};
  return { dispatchable, inputNames: new Set(Object.keys(inputs)) };
}
