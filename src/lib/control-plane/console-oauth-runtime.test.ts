import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { consoleRuntimeMutationSchema, nextConsoleRuntimeState, assertConsoleRuntimeWorker } from './console-oauth-runtime';
const state = { credentialId: 'shared/apps-in-toss/console-oauth' as const, generation: 4, phase: 'ACTIVE' as const, secretVersion: 'projects/123456/secrets/oauth/versions/7', attemptId: null };
test('runtime 전이는 고정 credential/workspace·정확한 버전과 증가 generation만 허용한다', () => {
    const attemptId = randomUUID();
    const flight = nextConsoleRuntimeState({ operation: 'BEGIN', workspaceId: 38345, expected: state, attemptId });
    assert.equal(flight.phase, 'REFRESH_IN_FLIGHT');
    assert.equal(flight.generation, 4);
    const next = nextConsoleRuntimeState({ operation: 'COMPLETE', workspaceId: 38345, expected: flight, secretVersion: 'projects/123456/secrets/oauth/versions/8' });
    assert.equal(next.generation, 5);
    assert.equal(next.attemptId, null);
    assert.throws(() => nextConsoleRuntimeState({ operation: 'BEGIN', workspaceId: 38345, expected: flight, attemptId }));
    assert.throws(() => nextConsoleRuntimeState({ operation: 'COMPLETE', workspaceId: 38345, expected: state, secretVersion: state.secretVersion }));
    for (const extra of [{ refreshToken: 'secret' }, { accessToken: 'secret' }, { workspaceId: 123 }, { expected: { ...state, secretVersion: 'projects/123456/secrets/oauth/versions/latest' } }])
        assert.equal(consoleRuntimeMutationSchema.safeParse({ operation: 'BEGIN', workspaceId: 38345, expected: state, attemptId, ...extra }).success, false);
});
test('다른 purpose/workspace principal은 공유 OAuth runtime을 조작할 수 없다', () => { const previous = process.env.AIT_CONSOLE_RUNTIME_PRINCIPAL; try {
    process.env.AIT_CONSOLE_RUNTIME_PRINCIPAL = 'worker:console';
    assert.doesNotThrow(() => assertConsoleRuntimeWorker({ kind: 'worker', principal: 'worker:console', workspaceId: 38345 }));
    assert.throws(() => assertConsoleRuntimeWorker({ kind: 'worker', principal: 'worker:other', workspaceId: 38345 }));
    assert.throws(() => assertConsoleRuntimeWorker({ kind: 'worker', principal: 'worker:console', workspaceId: 123 } as never));
    delete process.env.AIT_CONSOLE_RUNTIME_PRINCIPAL;
    assert.throws(() => assertConsoleRuntimeWorker({ kind: 'worker', principal: 'worker:console', workspaceId: 38345 }));
}
finally {
    if (previous === undefined)
        delete process.env.AIT_CONSOLE_RUNTIME_PRINCIPAL;
    else
        process.env.AIT_CONSOLE_RUNTIME_PRINCIPAL = previous;
} });
test('정본 전환·DB 복구 초기 등록은 확인한 grant generation을 보존하고 되돌리지 않는다',()=>{
 const first=nextConsoleRuntimeState({operation:'REGISTER',workspaceId:38345,expected:null,secretVersion:'projects/123456/secrets/oauth/versions/9',registeredGeneration:7} as never);assert.equal(first.generation,7);
 assert.throws(()=>nextConsoleRuntimeState({operation:'REGISTER',workspaceId:38345,expected:state,secretVersion:'projects/123456/secrets/oauth/versions/9',registeredGeneration:3} as never));
});
