import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  legacyResolutionJustification,
  missingLegacyResolutionEvidenceKinds,
  nextLegacyResolutionTargets,
  suggestedLegacyResolutionDispositions,
} from "./legacy-config-resolution-selection";

describe("nextLegacyResolutionTargets", () => {
  it("IGNORED_NON_OPERATIONAL을 선택하면 다른 target을 제거한다", () => {
    assert.deepEqual(
      nextLegacyResolutionTargets(["CONFIG_REVISION", "STORE_ASSET"], "IGNORED_NON_OPERATIONAL"),
      ["IGNORED_NON_OPERATIONAL"],
    );
  });

  it("다른 target을 선택하면 IGNORED_NON_OPERATIONAL을 해제한다", () => {
    assert.deepEqual(
      nextLegacyResolutionTargets(["IGNORED_NON_OPERATIONAL"], "CONFIG_REVISION"),
      ["CONFIG_REVISION"],
    );
  });

  it("선택된 target을 다시 누르면 제거한다", () => {
    assert.deepEqual(
      nextLegacyResolutionTargets(["CONFIG_REVISION"], "CONFIG_REVISION"),
      [],
    );
  });
});

describe("suggestedLegacyResolutionDispositions", () => {
  it("사유별로 현재 존재하는 최소 중앙 증거를 선택한다", () => {
    const dispositions = suggestedLegacyResolutionDispositions({
      reasonCodes: [
        "FREE_TEXT_REQUIRES_INPUT",
        "LEGAL_COMPLIANCE_AMBIGUITY",
        "PROVIDER_STATE_AMBIGUITY",
        "SECRET_LIKE_KEY",
      ],
      availableEvidenceKinds: [
        "CONFIG_REVISION",
        "COMPLIANCE_PROFILE",
        "PROVIDER_OBSERVATION",
        "CREDENTIAL_BINDING",
      ],
    });

    assert.deepEqual(dispositions, [
      { reasonCode: "FREE_TEXT_REQUIRES_INPUT", targets: ["CONFIG_REVISION"] },
      { reasonCode: "LEGAL_COMPLIANCE_AMBIGUITY", targets: ["COMPLIANCE_PROFILE"] },
      { reasonCode: "PROVIDER_STATE_AMBIGUITY", targets: ["PROVIDER_OBSERVATION"] },
      { reasonCode: "SECRET_LIKE_KEY", targets: ["CREDENTIAL_BINDING"] },
    ]);
    assert.deepEqual(missingLegacyResolutionEvidenceKinds(dispositions), []);
    assert.equal(legacyResolutionJustification(dispositions), "CENTRAL_STATE_REVIEWED");
  });

  it("없는 Compliance와 Credential 증거를 정확히 표시한다", () => {
    const dispositions = suggestedLegacyResolutionDispositions({
      reasonCodes: ["LEGAL_COMPLIANCE_AMBIGUITY", "SECRET_LIKE_KEY"],
      availableEvidenceKinds: ["CONFIG_REVISION"],
    });

    assert.deepEqual(dispositions, [
      { reasonCode: "LEGAL_COMPLIANCE_AMBIGUITY", targets: [] },
      { reasonCode: "SECRET_LIKE_KEY", targets: [] },
    ]);
    assert.deepEqual(missingLegacyResolutionEvidenceKinds(dispositions), [
      "COMPLIANCE_PROFILE",
      "CREDENTIAL_BINDING",
    ]);
  });

  it("desired state 부재만 비운영 값 사람 검토 사유로 제한한다", () => {
    const dispositions = suggestedLegacyResolutionDispositions({
      reasonCodes: ["NO_REPRESENTABLE_SOURCE"],
      availableEvidenceKinds: ["CONFIG_REVISION"],
    });

    assert.deepEqual(dispositions, [{
      reasonCode: "NO_REPRESENTABLE_SOURCE",
      targets: ["IGNORED_NON_OPERATIONAL"],
    }]);
    assert.equal(legacyResolutionJustification(dispositions), "NO_LEGACY_DESIRED_STATE");
  });
});
