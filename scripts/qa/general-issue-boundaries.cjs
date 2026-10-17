// 격리 런타임용 외부 경계. 운영 이미지에는 이 파일을 번들하지 않는다.
const { generateKeyPairSync } = require('node:crypto');
const database = new URL(process.env.DATABASE_URL || 'http://invalid');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.pathname !== '/backoffice_qa') throw new Error('ISOLATED_DATABASE_REQUIRED');
Object.assign(process.env, {
  FEATURE_GENERAL_ISSUES_ENABLED: 'true', FEATURE_CLAUDE_ENABLED: 'true', CHAT_LLM_PROVIDER: 'anthropic', CLAUDE_API_KEY_IH: 'qa-synthetic-key',
  GITHUB_APP_ID: '999', DISCORD_GUILD_ID: '100', DISCORD_CHANNEL_BACKOFFICE_ID: '200', DISCORD_CHANNEL_RELEASE_OPS_ID: '201', DISCORD_ROLE_PRODUCT_ID: 'product', DISCORD_ROLE_DEVELOPMENT_ID: 'development', DISCORD_ROLE_VIEWER_ID: 'viewer', DISCORD_BOT_TOKEN: 'qa-synthetic-bot',
  AUTH_SECRET: 'qa-isolated-general-issues-secret', AUTH_TRUST_HOST: 'true', AUTH_URL: 'http://localhost:3307',
});
process.env.GITHUB_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const state = global.__generalIssueQa = { issues: [], messages: [], mode: 'ok', writes: 0, memberRoles: ['product'] };
const originalFetch = global.fetch;
global.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input));
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) return originalFetch(input, init);
  if (url.hostname === 'api.anthropic.com') {
    if (state.mode === 'claude-fail') return Response.json({ error: 'qa' }, { status: 503 });
    return Response.json({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: body.system?.includes('일반 요청') ? JSON.stringify({ title: '설정 조사 요청', body: '## 요청\n설정 화면의 알림 설정 방법을 조사해 주세요.' }) : '## 기획·버그 초안\n요청 내용 확인' }] });
  }
  if (url.hostname === 'discord.com') {
    if (url.pathname.includes('/members/')) return Response.json({ roles: state.memberRoles });
    state.messages.push({ url: url.pathname, method, body });
    return Response.json({ id: String(800 + state.messages.length) });
  }
  if (url.hostname === 'api.github.com') {
    if (url.pathname === '/orgs/seorilabs/installation') return Response.json({ id: 999, app_id: 999, target_id: 999, account: { id: 999, login: 'seorilabs', type: 'Organization' }, repository_selection: 'all', target_type: 'Organization', permissions: {}, events: [] });
    if (url.pathname.includes('/access_tokens')) return Response.json({ token: 'qa-synthetic-installation', expires_at: new Date(Date.now() + 3600000).toISOString() });
    if (url.pathname.endsWith('/issues') && method === 'POST') {
      if (state.mode === 'github-denied') return Response.json({ message: 'qa denied' }, { status: 403 });
      const repo = url.pathname.split('/').slice(2, 4).join('/');
      const issue = { number: 100 + ++state.writes, node_id: `QA_${state.writes}`, title: body.title, body: body.body, html_url: `https://github.com/${repo}/issues/${100 + state.writes}`, state: 'open', state_reason: null, user: { login: 'qa-bot' }, assignees: [], labels: body.labels || [], milestone: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      state.issues.push(issue);
      if (state.mode === 'github-unknown') throw new TypeError('qa network interrupted after write');
      return Response.json(issue, { status: 201 });
    }
    if (url.pathname.endsWith('/issues')) return Response.json(state.issues);
    if (/\/issues\/\d+$/.test(url.pathname)) return Response.json(state.issues.find(i => i.number === Number(url.pathname.split('/').pop())) || {});
    if (url.pathname.endsWith('/tags') || url.pathname.endsWith('/releases')) return Response.json([]);
    if (url.pathname.endsWith('/actions/runs')) return Response.json({ total_count: 0, workflow_runs: [] });
    if (url.pathname.endsWith('/actions/workflows')) return Response.json({ total_count: 0, workflows: [] });
    if (url.pathname.endsWith('/readme')) return Response.json({ message: 'qa missing' }, { status: 404 });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return Response.json({ id: 1000, full_name: url.pathname.slice(7), default_branch: 'main' });
    if (url.pathname.includes('/git/ref/')) return Response.json({ object: { sha: 'a'.repeat(40) } });
    if (url.pathname.includes('/git/trees/')) return Response.json({ tree: [] });
    if (url.pathname.includes('/contents/')) return Response.json({ message: 'qa no code context' }, { status: 404 });
    if (url.pathname.endsWith('/git/trees/HEAD')) return Response.json({ tree: [] });
    if (method === 'GET') return Response.json({ message: 'qa not configured' }, { status: 404 });
    throw new Error(`UNEXPECTED_QA_GITHUB_REQUEST ${method} ${url.pathname}`);
  }
  throw new Error(`EXTERNAL_QA_NETWORK_BLOCKED ${url.hostname}`);
};
