def evidence_id:
  if type != "string" then false else test("^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$") end;
def digest:
  if type != "string" then false else test("^sha256:[0-9a-f]{64}$") end;

if type != "object" then
  error("FLEET_MIGRATION_INVENTORY_ISSUER_EVIDENCE_INVALID")
elif keys != [
  "authoritativeState",
  "contract",
  "inventoryDigest",
  "issuanceDigest",
  "keyFingerprint",
  "occurrenceId",
  "privateKeyInput",
  "providerVectorDigest",
  "runId",
  "schemaVersion",
  "secretValuesReturned",
  "state"
] then
  error("FLEET_MIGRATION_INVENTORY_ISSUER_EVIDENCE_KEYS_INVALID")
elif (
  .schemaVersion != 1
  or .contract != "seorilabs-fleet-migration-authoritative-inventory-v1"
  or (.state != "PRESERVED" and .state != "REPLAYED")
  or .authoritativeState != "READY"
  or .occurrenceId != $occurrence
  or ((.occurrenceId | evidence_id) | not)
  or .runId != $run
  or ((.runId | evidence_id) | not)
  or .providerVectorDigest != $provider
  or ((.providerVectorDigest | digest) | not)
  or ((.inventoryDigest | digest) | not)
  or ((.issuanceDigest | digest) | not)
  or ((.keyFingerprint | digest) | not)
  or .privateKeyInput != false
  or .secretValuesReturned != false
) then
  error("FLEET_MIGRATION_INVENTORY_ISSUER_EVIDENCE_BINDING_INVALID")
else
  {
    schemaVersion,
    contract,
    state,
    authoritativeState,
    inventoryDigest,
    issuanceDigest,
    keyFingerprint,
    occurrenceId,
    runId,
    providerVectorDigest,
    privateKeyInput,
    secretValuesReturned
  }
end
