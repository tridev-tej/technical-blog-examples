import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApi } from './api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pwsh = process.env.PWSH;
assert.ok(pwsh, 'Set PWSH to the PowerShell executable');
const ids = values => values.map(id => ({ id }));
const result = (values, requests, fetched, status, reason) => ({
  Items: ids(values), RequestsAttempted: requests, ItemsFetched: fetched,
  ItemsReturned: values.length, Status: status, StopReason: reason,
  IsComplete: status === 'Complete'
});
const complete = (values, requests, fetched) => result(values, requests, fetched, 'Complete', 'EndOfData');
const partial = (values, requests, fetched, reason) => result(values, requests, fetched, 'Partial', reason);
const error = (values, requests, fetched, reason) => result(values, requests, fetched, 'Error', reason);
const cases = [
  ['normal', {}, complete([1,2,3,4,5],3,5), ['r','A','B']],
  ['empty', {}, complete([],1,0), ['r']],
  ['emptyAfter', {}, complete([1,2],2,2), ['r','A']],
  ['emptyNext', {}, complete([1],2,1), ['r','A']],
  ['normal', {MaxPages:2}, partial([1,2,3,4],2,4,'PageBudget'), ['r','A']],
  ['normal', {MaxPages:3}, complete([1,2,3,4,5],3,5), ['r','A','B']],
  ['normal', {MaxPages:4}, complete([1,2,3,4,5],3,5), ['r','A','B']],
  ['normal', {MaxItems:3}, partial([1,2,3],2,4,'ItemBudget'), ['r','A']],
  ['normal', {MaxItems:4}, partial([1,2,3,4],2,4,'ItemBudget'), ['r','A']],
  ['normal', {MaxItems:5}, complete([1,2,3,4,5],3,5), ['r','A','B']],
  ['oversized', {MaxItems:2}, partial([1,2],1,3,'ItemBudget'), ['r']],
  ['normal', {MaxPages:1,MaxItems:2}, partial([1,2],1,2,'ItemBudget'), ['r']],
  ['emptyAfter', {MaxItems:2}, partial([1,2],1,2,'ItemBudget'), ['r']],
  ['repeat', {}, error([1,2],2,4,'RepeatedToken'), ['r','A']],
  ['cycle', {}, error([1,2,3,4],3,6,'RepeatedToken'), ['r','A','B']],
  ['caseSensitive', {}, complete([1,2,3],3,3), ['r','A','a']],
  ['firstFailure', {}, error([],1,0,'ReadFailed'), ['r']]
];
const malformed = ['json','nullRoot','scalarRoot','missingItems','nullItems','scalarItems',
  'badItem','nullItem','fractionalId','booleanId','missingId','missingToken','numberToken',
  'objectToken','emptyToken','urlToken','newlineToken','longToken','429','503','redirect','stall'];
for (const name of malformed) cases.push([name, {}, error([1,2],2,2,'ReadFailed'), ['r','A']]);
for (const key of ['MaxPages','MaxItems']) {
  for (const value of [0,-1,1.5,true,null,'2',2147483648,[],{}]) {
    cases.push(['normal', {[key]:value}, error([],0,0,'InvalidArgument'), []]);
  }
}
for (const endpoint of ['https://example.invalid/normal','http://127.0.0.1/normal?x=1',
  'http://u@127.0.0.1/normal','http://127.0.0.1/normal#x','not a uri',null]) {
  cases.push(['normal', {Endpoint:endpoint}, error([],0,0,'InvalidArgument'), []]);
}
cases.push(['normal', {MaxPages:2147483647,MaxItems:2147483647}, complete([1,2,3,4,5],3,5), ['r','A','B']]);
cases.push(['extraFields', {}, {...complete([],1,1), Items:[{id:-1,label:'kept'}], ItemsReturned:1}, ['r']]);

function launch(directory, requestFile, entry = 'Invoke-Case.ps1', parameter = '-RequestFile') {
  return new Promise((resolve, reject) => {
    const child = spawn(pwsh, ['-NoLogo','-NoProfile','-NonInteractive','-File',join(directory,entry),parameter,requestFile]);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('10-second watchdog expired')); }, 10000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({code,stdout,stderr}); });
  });
}

function expectedTrace(scenario, cursors) {
  return cursors.map(cursor => ({method:'GET',url:`/${scenario}${cursor === 'r' ? '' : `?cursor=${encodeURIComponent(cursor)}`}`}));
}

async function runCase(api, directory, scratch, test, index) {
  const [scenario, budgets, expected, cursors] = test;
  const requestFile = join(scratch,`request-${index}.json`);
  await writeFile(requestFile,JSON.stringify([{Endpoint:`${api.base}/${scenario}`,MaxPages:10,MaxItems:100,...budgets}]));
  const start = api.trace.length;
  const destinationStart = api.destinationTrace.length;
  const observed = await launch(directory,requestFile);
  const record = {index,scenario,budgets,expected,expectedTrace:expectedTrace(scenario,cursors),...observed,
    trace:api.trace.slice(start),destinationTrace:api.destinationTrace.slice(destinationStart)};
  process.stdout.write(`${JSON.stringify(record)}\n`);
  assert.equal(observed.code,0,`case ${index} native exit`);
  const actual = JSON.parse(observed.stdout);
  assert.deepEqual(actual,expected,`case ${index} complete result`);
  assert.deepEqual(record.trace,record.expectedTrace,`case ${index} actual HTTP trace`);
  assert.deepEqual(record.destinationTrace,[],`case ${index} redirect destination untouched`);
  if (expected.Status === 'Error') assert.notEqual(observed.stderr.trim(),'','error diagnostic');
  else assert.equal(observed.stderr,'','successful stderr');
}

async function repeatedCalls(api, scratch) {
  const requestFile = join(scratch,'twice.json');
  const request = {Endpoint:`${api.base}/normal`,MaxPages:10,MaxItems:100};
  await writeFile(requestFile,JSON.stringify([request,request]));
  const start = api.trace.length;
  const observed = await launch(here,requestFile);
  process.stdout.write(`${JSON.stringify({kind:'same-process',...observed,trace:api.trace.slice(start)})}\n`);
  assert.equal(observed.code,0);
  assert.deepEqual(observed.stdout.trim().split('\n').map(line => JSON.parse(line)),[complete([1,2,3,4,5],3,5),complete([1,2,3,4,5],3,5)]);
  assert.deepEqual(api.trace.slice(start),[...expectedTrace('normal',['r','A','B']),...expectedTrace('normal',['r','A','B'])]);
}

async function numericProbes(api, scratch) {
  const requestFile = join(scratch,'numeric.txt');
  await writeFile(requestFile,`${api.base}/normal`);
  const start = api.trace.length;
  const observed = await launch(here,requestFile,'Invoke-NumericProbe.ps1');
  process.stdout.write(`${JSON.stringify({kind:'typed-budget-probes',...observed,trace:api.trace.slice(start)})}\n`);
  assert.equal(observed.code,0);
  const expected = [
    ...Array.from({length:12}, () => error([],0,0,'InvalidArgument')),
    partial([1,2],1,2,'PageBudget'),partial([1],1,2,'ItemBudget')
  ];
  assert.deepEqual(observed.stdout.trim().split('\n').map(line => JSON.parse(line)),expected);
  assert.deepEqual(api.trace.slice(start),[...expectedTrace('normal',['r']),...expectedTrace('normal',['r'])]);
  assert.notEqual(observed.stderr.trim(),'');
}

async function examples(api) {
  const start = api.trace.length;
  const observed = await launch(here,api.base,'Show-Examples.ps1','-Base');
  process.stdout.write(`${JSON.stringify({kind:'article-examples',...observed,trace:api.trace.slice(start)})}\n`);
  assert.equal(observed.code,0);
  assert.deepEqual(observed.stdout.trim().split('\n').map(line => JSON.parse(line)),[
    complete([1,2,3,4,5],3,5),partial([1,2,3,4],2,4,'PageBudget'),error([1,2],2,4,'RepeatedToken')]);
  assert.deepEqual(api.trace.slice(start),[
    ...expectedTrace('normal',['r','A','B']),...expectedTrace('normal',['r','A']),...expectedTrace('repeat',['r','A'])]);
  assert.match(observed.stderr,/Continuation refers/);
}

async function mutation(api, scratch) {
  const mutant = join(scratch,'mutant');
  await cp(here,mutant,{recursive:true});
  const sourcePath = join(mutant,'Get-BoundedPage.ps1');
  const source = await readFile(sourcePath,'utf8');
  const site = 'if (Test-RepeatedContinuation $page $state.Seen) {';
  assert.equal(source.split(site).length,2,'single verified mutation site');
  await writeFile(sourcePath,source.replace(site,'if ($false) {'));
  await runCase(api,mutant,scratch,cases[0],'mutant-control');
  await assert.rejects(runCase(api,mutant,scratch,cases[13],'mutant-repeat'), /complete result|actual HTTP trace/);
  await assert.rejects(runCase(api,mutant,scratch,cases[14],'mutant-cycle'), /complete result|actual HTTP trace/);
  process.stdout.write(`${JSON.stringify({kind:'mutation',ordinaryControl:'passed',repeat:'rejected',cycle:'rejected'})}\n`);
  await runCase(api,here,scratch,cases[13],'restored-repeat');
}

async function main() {
  const scratch = await mkdtemp(join(here,'..','run-work-'));
  const api = await startApi();
  process.stdout.write(`${JSON.stringify({kind:'ready',base:api.base,node:process.version,pwsh,scratch})}\n`);
  try {
    for (const [index,test] of cases.entries()) await runCase(api,here,scratch,test,index);
    await runCase(api,here,scratch,cases[0],'fresh-process-replay');
    await repeatedCalls(api,scratch);
    await numericProbes(api,scratch);
    await examples(api);
    await mutation(api,scratch);
    process.stdout.write(`${JSON.stringify({kind:'summary',cases:cases.length,passed:true})}\n`);
  } finally {
    await api.close();
  }
}

await main();
