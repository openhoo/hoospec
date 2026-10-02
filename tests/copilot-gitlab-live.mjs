// Real disposable GitLab + runner; GitHub/Copilot responses are synthetic.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GitLabClient } from '../src/lib/gitlab-client.ts';
import { CopilotRunnerConnection } from '../src/lib/copilot-runner.ts';
import { flattenNodes } from '../src/lib/gherkin.ts';
import { parseDocument } from '../src/lib/document.ts';
const instance = process.env.HOOSPEC_TEST_GITLAB_URL || 'http://127.0.0.1:8929';
if (!['localhost','127.0.0.1'].includes(new URL(instance).hostname)) throw new Error('Only local disposable GitLab instances allowed');
if (!process.env.HOOSPEC_TEST_GITLAB_TOKEN_FILE) throw new Error('Set HOOSPEC_TEST_GITLAB_TOKEN_FILE');
const token = (await readFile(process.env.HOOSPEC_TEST_GITLAB_TOKEN_FILE,'utf8')).trim();
async function api(path, method='GET', body) {
  const response = await fetch(instance+'/api/v4'+path, {method, headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
  if (!response.ok) { const error = await response.json(); console.error('GitLab fixture error:', error.message || error.errors); throw new Error(`GitLab fixture request failed (${response.status})`); }
  return response.json();
}
const project = await api('/projects','POST',{name:'hoospec-copilot-runner-'+Date.now(), visibility:'private', initialize_with_readme:true, default_branch:'main', ci_pipeline_variables_minimum_override_role:'developer'});
let connection;
try {
  const runners = await api('/runners/all');
  const runner = runners.find(item => item.description === 'Hoospec isolated test runner' && item.status === 'online');
  if (!runner) throw new Error('Local isolated Hoospec test runner not found');
  await api(`/projects/${project.id}/runners`, 'POST', {runner_id: runner.id});
  const fixture = `import {runLogin} from './scripts/copilot-login.mjs';
await runLogin(process.env, {sleep: async () => {}, fetcher: async url => {
 if(url.endsWith('/device/code')) return Response.json({device_code:'synthetic-device',user_code:'TEST-CODE',expires_in:900,interval:5});
 if(url.endsWith('/access_token')) return Response.json({access_token:'gho_synthetic_oauth'});
 return Response.json({token:'synthetic-copilot-api-token',expires_at:Math.floor(Date.now()/1000)+600,endpoints:{api:'https://api.githubcopilot.com'}});
}});`;
  const actions = [
    {action:'create',file_path:'scripts/copilot-login.mjs',content:await readFile(new URL('../scripts/copilot-login.mjs',import.meta.url),'utf8')},
    {action:'create',file_path:'.gitlab/copilot.yml',content:await readFile(new URL('../.gitlab/copilot.yml',import.meta.url),'utf8')},
    {action:'create',file_path:'fixture.mjs',content:fixture},
    {action:'create',file_path:'.gitlab-ci.yml',content:'include:\n  - local: .gitlab/copilot.yml\nhoospec-copilot-login:\n  extends: .hoospec-copilot-login\n  script:\n    - node fixture.mjs\n'},
  ];
  await api(`/projects/${project.id}/repository/commits`,'POST',{branch:'main',commit_message:'Disposable Copilot runner fixture',actions});
  const client = new GitLabClient({instance,project:String(project.id),branch:'main',directory:'hoospec',specDirectory:'',adrDirectory:'docs/adr',clientId:''},token);
  let directCalls = 0;
  const direct = async (url,init) => {
    directCalls++; assert.ok(String(url).startsWith('https://api.githubcopilot.com/'));
    assert.equal(init.headers.Authorization,'Bearer synthetic-copilot-api-token');
    if(String(url).endsWith('/models')) return Response.json({data:[{id:'fixture',name:'Fixture',capabilities:{type:'chat'},supported_endpoints:['/chat/completions']}]});
    return new Response('data: '+JSON.stringify({choices:[{delta:{content:'    Given the runner login works'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  };
  connection = new CopilotRunnerConnection(client,'own-fixture-app',direct);
  assert.equal((await connection.start()).userCode,'TEST-CODE');
  console.log('✓ real GitLab API pipeline, runner and login-code trace');
  let ready = false;
  for(let tries=0;tries<60;tries++) {
    if((await connection.poll()).connected) {ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  assert.ok(ready); assert.equal(connection.models[0].id,'fixture');
  console.log('✓ runner encrypts artifact; only initiating browser key decrypts it');
  const source='Feature: Runner\n  Scenario: Connect\n    Given a test\n';
  const node=flattenNodes(parseDocument(source,'runner.feature')).find(item=>item.kind==='step');
  const response=await connection.agent({source,filename:'runner.feature',nodeId:node.id,instruction:'Change'});
  assert.ok((await response.text()).includes('Given the runner login works')); assert.equal(directCalls,2);
  console.log('✓ direct browser adapter handles Copilot model list and streaming result (synthetic provider)');
  const {data: pipelines}=await client.api(`/projects/${project.id}/pipelines`);
  const {data: variables}=await client.api(`/projects/${project.id}/pipelines/${pipelines[0].id}/variables`);
  assert.ok(!JSON.stringify(variables).includes('synthetic-copilot-api-token'));
  assert.ok(!JSON.stringify(variables).includes('gho_synthetic_oauth'));
  console.log('✓ no OAuth or Copilot credentials in pipeline variables');
  connection.disconnect();
  console.log('Disposable project:',project.id);
} finally {
  connection?.disconnect();
  await fetch(`${instance}/api/v4/projects/${project.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}});
}
