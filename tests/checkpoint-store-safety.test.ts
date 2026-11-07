import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {CheckpointStore,validateRepoPath,parseManifest,type CheckpointManifest} from '../src/main/checkpointStore';
const shortWrites = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:fs", async (importOriginal) => {
 const actual = await importOriginal<typeof import("node:fs")>();
 return { ...actual, writeSync: (fd: number, data: Buffer | string, offset = 0, length?: number) => {
  if (typeof data === "string") return actual.writeSync(fd, data);
  const count = length ?? data.length - offset;
  return actual.writeSync(fd, data, offset, shortWrites.enabled ? Math.min(count, 3) : count);
 }};
});
const roots:string[]=[];
const tmp=()=>{const d=mkdtempSync(join(tmpdir(),'tivano-ckpt-store-lead-'));roots.push(d);return d;};
afterEach(()=>{shortWrites.enabled=false;for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(){const home=tmp(),root=join(home,'store'),store=new CheckpointStore(root),scratch=store.newScratch();const payload=Buffer.from('payload');const sha=store.putBlob(payload,scratch);const id=randomUUID();const m:CheckpointManifest={version:1,checkpointId:id,projectId:'p',threadId:'t',turnId:'turn',phase:'before',createdAt:1,grantDir:home,worktree:home,objectFormat:'sha1',headOid:null,branch:null,pathCount:1,totalBytes:payload.length,limitations:[],entries:[{path:'a.txt',worktree:{kind:'file',sha256:sha,size:payload.length,exec:false},index:[]}]};store.publishManifest(m);return {home,root,store,scratch,payload,sha,id,m};}
describe('checkpoint store physical ownership',()=>{
 it('a reopened store refuses a symlinked manifest directory',()=>{const f=fixture();const moved=join(f.home,'outside-manifests');renameSync(join(f.root,'manifests'),moved);symlinkSync(moved,join(f.root,'manifests'));expect(()=>new CheckpointStore(f.root).loadManifest(f.id)).toThrow();});
 it('a reopened store refuses a symlinked blob hash directory',()=>{const f=fixture();const dir=join(f.root,'blobs',f.sha.slice(0,2)),moved=join(f.home,'outside-hash');renameSync(dir,moved);symlinkSync(moved,dir);expect(()=>new CheckpointStore(f.root).readBlob(f.sha,f.payload.length)).toThrow();expect(()=>f.store.putBlob(f.payload,f.scratch)).toThrow();});
 it('issued scratch cannot be replaced by a symlink before writing',()=>{const f=fixture();const moved=join(f.home,'outside-scratch');renameSync(f.scratch,moved);symlinkSync(moved,f.scratch);expect(()=>f.store.putBlob(Buffer.from('different'),f.scratch)).toThrow();});
 it('cleanup preserves a replacement directory at the old scratch path',()=>{const f=fixture();renameSync(f.scratch,join(f.home,'original-scratch'));mkdirSync(f.scratch);const file=join(f.scratch,'user-file');writeFileSync(file,'keep');f.store.dropScratch(f.scratch);expect(existsSync(file)).toBe(true);expect(readFileSync(file,'utf8')).toBe('keep');});
 it('case-folded Git control paths are refused',()=>{for(const p of ['.GIT/config','sub/.Git/index','.git/HEAD'])expect(validateRepoPath(p)).toBeNull();});
 it('manifest index object format and stages are consistent',()=>{const f=fixture();const mutate=(index:any)=>({...f.m,entries:[{...f.m.entries[0]!,index}]});expect(parseManifest(mutate([{mode:'100644',oid:'a'.repeat(41),stage:0}]))).toBeNull();expect(parseManifest(mutate([{mode:'100644',oid:'a'.repeat(40),stage:0},{mode:'100644',oid:'b'.repeat(40),stage:0}]))).toBeNull();expect(parseManifest(mutate([{mode:'100644',oid:'a'.repeat(40),stage:0},{mode:'100644',oid:'b'.repeat(40),stage:2}]))).toBeNull();});
});

it("durable writes finish short writes before publishing manifests",()=>{
 const f=fixture();shortWrites.enabled=true;const bytes=Buffer.from("complete payload despite short writes");
 const hash=f.store.putBlob(bytes,f.scratch);expect(f.store.readBlob(hash,bytes.length)).toEqual(bytes);
 const m:CheckpointManifest={...f.m,checkpointId:randomUUID(),totalBytes:bytes.length,entries:[{path:"b.txt",worktree:{kind:"file",sha256:hash,size:bytes.length,exec:false},index:[]}]};
 f.store.publishManifest(m);expect(f.store.loadManifest(m.checkpointId)).toEqual(m);
});
