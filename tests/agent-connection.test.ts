import test from 'node:test';
import assert from 'node:assert/strict';
import { agentConnection, agentModel, invalidateAgentConnection } from '../src/lib/agent-connection';

test('AI readiness requires authenticated catalog access and restricts chosen models', async () => {
  const names = ['HOOSPEC_AI_KEY','HOOSPEC_AI_MODEL','HOOSPEC_AI_BASE_URL','HOOSPEC_AI_MODELS'];
  const env = Object.fromEntries(names.map(name => [name, process.env[name]])); const original = globalThis.fetch;
  try {
    delete process.env.HOOSPEC_AI_KEY; assert.equal((await agentConnection()).aiReady,false);
    Object.assign(process.env,{HOOSPEC_AI_KEY:'synthetic-key',HOOSPEC_AI_MODEL:'one',HOOSPEC_AI_BASE_URL:'https://provider.test/v1',HOOSPEC_AI_MODELS:'one,two'});
    let calls=0;
    globalThis.fetch = async (_url, init) => { calls++; assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer synthetic-key'); return Response.json({data:[{id:'one'},{id:'two',name:'Second model'},{id:'disallowed'}]}); };
    const [one,two] = await Promise.all([agentConnection(),agentConnection()]); assert.deepEqual(one,two);assert.equal(calls,1);
    assert.equal(one.aiReady,true);assert.deepEqual(one.aiModels.map(item=>item.id),['one','two']);
    assert.equal(await agentModel('two'),'two'); await assert.rejects(agentModel('disallowed'),/nicht verfügbar/);
    invalidateAgentConnection(); assert.equal((await agentConnection()).aiReady,false);
    process.env.HOOSPEC_AI_KEY='synthetic-invalid';globalThis.fetch=async()=>Response.json({secret:'never expose'}, {status:401});
    const denied=await agentConnection();assert.equal(denied.aiReady,false);assert.ok(!JSON.stringify(denied).includes('secret'));
    await assert.rejects(agentModel(),/nicht verbunden/);
  } finally { globalThis.fetch=original;for(const name of names){if(env[name]===undefined)delete process.env[name];else process.env[name]=env[name];} }
});
