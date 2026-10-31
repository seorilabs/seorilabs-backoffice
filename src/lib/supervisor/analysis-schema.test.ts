import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv from "ajv";
import { proposalSchema } from "./contracts";

const analysis = JSON.parse(
  readFileSync("scripts/supervisor/analysis.schema.json", "utf8"),
);
const tools = analysis.properties.candidates.items.properties.tools;

test("대표 CLI의 도구 식별자는 기존 서버 계약과 일치한다", () => {
  assert.deepEqual(tools.items.enum, proposalSchema.shape.tools.element.options);
});

test("첫 자연 분석에서 서버가 거부한 도구 표기를 CLI 출력에서도 거부한다", () => {
  const validate = new Ajv().compile(tools);
  assert.equal(validate(["codex", "git", "github", "mcode"]), true);
  for (const label of ["Git", "GitHub API", "Godot", "npm", "MiniMax Code"]) {
    assert.equal(validate([label]), false, label);
    assert.equal(proposalSchema.shape.tools.safeParse([label]).success, false);
  }
});
