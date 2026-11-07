// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Node build utility tested through real ASAR fixtures.
import { inspectBuiltOutput, readGeneratedJson, REQUIRED_ASAR_ENTRIES, REQUIRED_WIN_PTY_FILES } from '../scripts/lib/package-plan.mjs';
// @ts-expect-error Shared JavaScript harness helper.
import { pathInside, expectedWindowsGitGate } from '../scripts/lib/smoke-flow.mjs';
const req=createRequire(import.meta.url);
const asar=req('@electron/asar');
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})});
const write=(root:string,path:string,content:string='fixture')=>{const p=join(root,path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,content)};
import { createHash } from 'node:crypto';
// The packaged job-helper contract: exe OUTSIDE the asar + pinned
// manifest INSIDE it. The fixture supplies a VALID pair by default so
// each test can then break exactly one thing.
const HELPER_CONTENT='fixture-helper';
const HELPER_SHA=createHash('sha256').update(HELPER_CONTENT).digest('hex');
const HELPER_MANIFEST=JSON.stringify({schema:'tivano-windows-job-helper-manifest/1',file:'tivano-job-helper.exe',sha256:HELPER_SHA,bytes:HELPER_CONTENT.length,specVersion:1,helperVersion:'1.1.0'});
async function fixture(extra?:string,opts?:{helper?:'valid'|'missing'|'tampered'}){
 const base=mkdtempSync(join(tmpdir(),'tivano-asar-probe-'));dirs.push(base);
 const app=join(base,'app'),out=join(base,'out'),unpacked=join(out,'win-unpacked');mkdirSync(app);mkdirSync(unpacked,{recursive:true});
 for(const p of REQUIRED_ASAR_ENTRIES){if(p==='dist/job-helper-manifest.json')write(app,p,HELPER_MANIFEST);else write(app,p);}
 if(extra)write(app,extra);
 write(unpacked,'Tivano Windows Dev.exe');write(out,'Tivano-Windows-Dev-test-setup.exe');
 for(const p of REQUIRED_WIN_PTY_FILES)write(unpacked,'resources/app.asar.unpacked/'+p);
 const helper=opts?.helper??'valid';
 if(helper!=='missing')write(unpacked,'resources/job-helper/tivano-job-helper.exe',helper==='tampered'?'tampered':HELPER_CONTENT);
 await asar.createPackage(app,join(unpacked,'resources/app.asar'));
 return {out,unpacked};
}
it('inspects real ASAR leading-slash entries and all unpacked native files',async()=>{
 const {out}=await fixture();const result=inspectBuiltOutput(out,process.cwd());expect(result.problems).toEqual([]);expect(result.unpackedManifest.fileCount).toBeGreaterThan(18);
});
it('rejects forbidden ASAR payloads using normalized actual archive paths',async()=>{
 const {out}=await fixture('src/secret.ts');expect(inspectBuiltOutput(out,process.cwd()).problems.join(' ')).toMatch(/forbidden payload/);
});
it('rejects an unpacked directory missing its executable',async()=>{
 const {out,unpacked}=await fixture();rmSync(join(unpacked,'Tivano Windows Dev.exe'));expect(inspectBuiltOutput(out,process.cwd()).problems).toContain('packaged executable missing');
});
it('rejects a package missing the packaged job-helper',async()=>{
 const {out}=await fixture(undefined,{helper:'missing'});expect(inspectBuiltOutput(out,process.cwd()).problems.join(' ')).toMatch(/job-helper missing/);
});
it('rejects a packaged job-helper whose bytes differ from the pinned manifest',async()=>{
 const {out}=await fixture(undefined,{helper:'tampered'});expect(inspectBuiltOutput(out,process.cwd()).problems.join(' ')).toMatch(/does not match its pinned identity/);
});
it('checks path components for Windows-style sibling and descendant paths',()=>{
 expect(pathInside('C:\\install','C:\\install\\resources')).toBe(true);
 expect(pathInside('C:\\install','C:\\installation')).toBe(false);
 expect(pathInside('C:\\install','C:\\other')).toBe(false);
});

it('accepts the observed Windows no-Git panel only with its matching IPC reason',()=>{
 expect(expectedWindowsGitGate({kind:'unavailable',reason:'no-git'},'Git\nGit executable not found\nRefresh')).toBe(true);
 for(const snapshot of [{kind:'unavailable',reason:'no-grant'},{kind:'unavailable',reason:'no-snapshot'},{kind:'ready',reason:'no-git'},null])
  expect(expectedWindowsGitGate(snapshot,'Git executable not found')).toBe(false);
 for(const text of ['','Git unavailable','Not a git repository','Folder unavailable','Loading Git executable not found later'])
  expect(expectedWindowsGitGate({kind:'unavailable',reason:'no-git'},text)).toBe(false);
});

it('reads the exact UTF-8 BOM format emitted by Windows PowerShell 5.1',()=>{
 const d=mkdtempSync(join(tmpdir(),'tivano-build-json-'));dirs.push(d);
 const f=join(d,'build-manifest.json');
 writeFileSync(f,'\uFEFF'+JSON.stringify({outputs:{'tivano-job-helper.exe':'abc'}}));
 expect(readGeneratedJson(f).outputs['tivano-job-helper.exe']).toBe('abc');
 writeFileSync(f,'\uFEFF{broken');expect(()=>readGeneratedJson(f)).toThrow();
});
it('rejects a second executable hidden inside ASAR',async()=>{
 const {out}=await fixture('dist/job-helper/tivano-job-helper.exe');
 expect(inspectBuiltOutput(out,process.cwd()).problems.join(' ')).toMatch(/helper.*asar/i);
});

it('Windows smoke refuses executor failure and mismatched non-repository UI',()=>{
 expect(expectedWindowsGitGate({kind:'not-repository'},'Git\nNot a Git repository\nRefresh')).toBe(true);
 expect(expectedWindowsGitGate({kind:'not-repository'},'Git executable not found')).toBe(false);
 expect(expectedWindowsGitGate({kind:'unavailable',reason:'executor-cleanup-unproven'},'Git is unavailable in this environment')).toBe(false);
 expect(expectedWindowsGitGate({kind:'ready'},'main')).toBe(false);
});
