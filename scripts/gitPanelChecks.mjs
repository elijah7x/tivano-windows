// Test-only delayed IPC responses exercise the real renderer after the
// real-Git integration assertions. These handlers exist only in the final
// isolated Electron test process, which is closed immediately afterward.
import { join } from "node:path";

export async function runGitPanelChecks({ app, page, projectId, outDir, check }) {
 const verify=(name,ok,detail)=>{check(name,ok,detail===undefined?"":JSON.stringify(detail));if(!ok)throw new Error(name);};
 const settle=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 await page.evaluate(()=>window.tivano.invoke("settings:set",{language:"en",theme:"light"}));
 if(await page.locator(".git-panel").count()) await page.locator(".term-toggle").filter({hasText:"Git"}).click();
 const snapshot=(n,label)=>({projectId:projectId,snapshotId:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,capturedAt:Date.now(),kind:'ready',branch:{name:label,detached:false,unborn:false},limitations:[],entries:[{id:`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,path:'alpha.txt',kind:'modified',staged:'M',unstaged:'M',unmerged:false,untracked:false,canDiffStaged:true,canDiffWorktree:true},{id:`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`,path:'untracked.txt',kind:'untracked',staged:'?',unstaged:'?',unmerged:false,untracked:true,canDiffStaged:false,canDiffWorktree:false}]});
 await app.evaluate(({ipcMain})=>{
  globalThis.__gitUi={overview:[],refresh:[],diff:[]};
  for(const [channel,key] of [['git:overview','overview'],['git:refresh','refresh'],['git:diff','diff']]){
   ipcMain.removeHandler(channel);ipcMain.handle(channel,(_e,p)=>new Promise((resolve,reject)=>globalThis.__gitUi[key].push({p,resolve,reject})));
  }
 });
 const waitCalls=async(key,n)=>{const end=Date.now()+5000;while(Date.now()<end){const count=await app.evaluate((_e,k)=>globalThis.__gitUi[k].length,key);if(count>=n)return;await new Promise(r=>setTimeout(r,20));}throw Error(key+' request not received '+n);};
 const event=async s=>{await app.evaluate(({BrowserWindow},snapshot)=>BrowserWindow.getAllWindows()[0].webContents.send('tivano:event',{type:'git-snapshot',snapshot}),s);};
 const resolve=async(key,i,value)=>app.evaluate((_e,{key,i,value})=>globalThis.__gitUi[key][i].resolve(value),{key,i,value});
 const patch=async(i,text)=>app.evaluate((_e,{i,text})=>{const q=globalThis.__gitUi.diff[i];q.resolve({...q.p,kind:'text',patch:text});},{i,text});
 await page.locator('.term-toggle').filter({hasText:'Git'}).click();await waitCalls('overview',1);
 await event(snapshot(2,'newer-event'));await page.waitForFunction(()=>document.querySelector('.git-branch')?.textContent.includes('newer-event'));
 await resolve('overview',0,snapshot(1,'old-overview'));await settle(page);
 verify('late overview cannot replace newer snapshot event',(await page.locator('.git-branch').innerText()).includes('newer-event'));
 await page.locator('.git-row[title="alpha.txt"]').first().click();await waitCalls('diff',1);
 await page.locator('.git-row[title="alpha.txt"]').first().click();await waitCalls('diff',2);
 await patch(1,'@@ -1 +1 @@\n-old\n+newest\n');await page.waitForFunction(()=>document.querySelector('.git-patch')?.textContent.includes('+newest'));
 await patch(0,'+stale-response\n');await settle(page);
 verify('same-entry responses obey request order',(await page.locator('.git-patch').innerText()).includes('+newest'));
 await page.locator('.git-row[title="alpha.txt"]').first().click();await waitCalls('diff',3);
 await page.locator('.git-row[title="untracked.txt"]').click();await patch(2,'+late-after-untracked\n');await settle(page);
 verify('untracked selection clears loading and ignores old diff',(await page.locator('.git-diff').innerText()).includes('No diff for this entry') && await page.locator('.git-diff .dots').count()===0);
 await page.locator('.git-row[title="alpha.txt"]').first().click();await waitCalls('diff',4);
 await event(snapshot(3,'replacement'));await page.waitForFunction(()=>document.querySelector('.git-branch')?.textContent.includes('replacement'));
 await patch(3,'+old-snapshot-diff\n');await settle(page);
 verify('new snapshot invalidates pending diff',(await page.locator('.git-diff').innerText()).includes('Select a file') && await page.locator('.git-patch').count()===0);
 await page.locator('.git-row[title="alpha.txt"]').first().click();await waitCalls('diff',5);await patch(4,'+x\n'.repeat(10001));
 await page.waitForFunction(()=>document.querySelector('.git-diff')?.textContent.includes('Diff is too large'));
 verify('newline-heavy patch is bounded before DOM expansion',await page.locator('.git-patch div').count()===0);
 await page.locator('.git-row[title="alpha.txt"]').first().click();await waitCalls('diff',6);
 await app.evaluate(()=>globalThis.__gitUi.diff[5].reject(new Error('injected diff failure')));await page.waitForFunction(()=>document.querySelector('.git-diff')?.textContent.includes('Git is unavailable'));
 verify('failed diff has a visible state',await page.locator('.git-diff .dots').count()===0);
 verify('handled Git error stays inside the panel',await page.locator('.app-error').count()===0);
 await page.locator('.git-refresh').click();await waitCalls('refresh',1);await event(snapshot(5,'latest-refresh-event'));
 await resolve('refresh',0,snapshot(4,'late-refresh-response'));await settle(page);
 verify('refresh response cannot overwrite newer event',(await page.locator('.git-branch').innerText()).includes('latest-refresh-event'));
 await page.locator('.git-row[title="alpha.txt"]').first().click();await waitCalls('diff',7);
 await patch(6,'diff --git a/alpha.txt b/alpha.txt\n--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1,2 +1,2 @@\n-old value\n+new value 中文\n+<img src=x onerror="alert(1)">\n context\n');await page.locator('.git-patch').waitFor();
 verify('diff markup is escaped',await page.locator('.git-patch img').count()===0 && (await page.locator('.git-patch').innerText()).includes('<img'));
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>window.tivano.invoke('settings:set',{theme}),theme);await settle(page);
  const contrast=await page.evaluate(()=>{
   const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');const panel=getComputedStyle(document.querySelector('.git-panel')).backgroundColor;
   const lum=rgb=>rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
   return ['pl','mi','hn','ctx'].map(cls=>{const el=document.querySelector('.git-patch .'+cls),style=getComputedStyle(el);ctx.clearRect(0,0,1,1);ctx.fillStyle=panel;ctx.fillRect(0,0,1,1);ctx.fillStyle=style.backgroundColor;ctx.fillRect(0,0,1,1);const bg=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);ctx.fillStyle=style.color;ctx.fillRect(0,0,1,1);const fg=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);const a=lum(bg),b=lum(fg);return {cls,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
  });
  verify(theme+' diff contrast',contrast.every(x=>x.ratio>=4.5),contrast);await page.screenshot({path:join(outDir,'32-git-ui-'+theme+'-en.png')});
 }
 await page.evaluate(()=>window.tivano.invoke('settings:set',{language:'zh-Hans'}));await page.waitForFunction(()=>document.querySelector('.git-panel')?.textContent.includes('已暂存'));await page.screenshot({path:join(outDir,'33-git-ui-dark-zh.png')});verify('Chinese diff controls visible',true);
}
