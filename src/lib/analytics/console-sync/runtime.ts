export const CONSOLE_CREDENTIAL_ID = 'shared/apps-in-toss/console-oauth' as const;
export interface ConsoleRuntimeState {
    credentialId: typeof CONSOLE_CREDENTIAL_ID;
    generation: number;
    phase: 'ACTIVE' | 'REFRESH_IN_FLIGHT';
    secretVersion: string;
    attemptId: string | null;
}
export interface ConsoleRuntimeLedger {
    read(): Promise<ConsoleRuntimeState>;
    assertLease(): Promise<void>;
    begin(expected: ConsoleRuntimeState, attemptId: string): Promise<ConsoleRuntimeState>;
    complete(expected: ConsoleRuntimeState, secretVersion: string): Promise<ConsoleRuntimeState>;
}
