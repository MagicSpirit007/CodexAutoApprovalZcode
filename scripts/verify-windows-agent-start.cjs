const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
if(process.platform !== 'win32') throw Error('Windows Node required');
const desktop=path.resolve(process.argv[2]), out=path.resolve(process.argv[3]);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'auto-review-build-start-'));
const env={...process.env,USERPROFILE:profile,APPDATA:path.join(profile,'appdata'),LOCALAPPDATA:path.join(profile,'localappdata'),HOME:profile,ZCODE_HOME:profile,ZCODE_STORAGE_DIR:path.join(profile,'storage'),ZCODE_SESSION_DB_PATH:path.join(profile,'sessions.db'),ZCODE_DATA_BASE_DIR:profile};
const agent=path.join(desktop,'resources/glm/zcode.cjs');
const records=[];
try {
 for(const [label,exe,args,extra] of [
 ['windows-node-help',process.execPath,[agent,'--help'],{}],
 ['electron-runtime',path.join(desktop,'ZCode.exe'),['-p','JSON.stringify({node:process.version,electron:process.versions.electron,platform:process.platform})'],{ELECTRON_RUN_AS_NODE:'1'}],
 ['electron-agent-help',path.join(desktop,'ZCode.exe'),[agent,'--help'],{ELECTRON_RUN_AS_NODE:'1'}]]) {
 const r=spawnSync(exe,args,{env:{...env,...extra},encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 records.push({label,status:r.status,error:r.error?.message,stdout:r.stdout?.slice(0,16000),stderr:r.stderr?.slice(0,4000)});
 }
}finally{fs.rmSync(profile,{recursive:true,force:true});}
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'windows-agent-start.json'),JSON.stringify({date:new Date().toISOString(),runner:process.version,isolatedProfileCleaned:true,records},null,2));
console.log(JSON.stringify(records.map(({label,status,error})=>({label,status,error}))));
if(records.some(r=>r.status!==0))process.exitCode=1;
