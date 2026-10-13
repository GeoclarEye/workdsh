import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

test('personal installer plans four default features, requires optional opt-in, and preserves an existing Profile',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workdsh-delivery-'));
 try {
  const names=['provider-identity-local','provider-browser-session','plugin-audit','plugin-access','plugin-skills','plugin-experts','plugin-connectors','plugin-library','plugin-scene-card','bundle','plugin-office','plugin-projects','plugin-activity'].map(n=>'workdsh-'+n);
  const packages=[];
  for(const name of names){const bytes=Buffer.from(name),filename=name+'.tgz';await writeFile(join(root,filename),bytes);packages.push({name,filename,sha256:createHash('sha256').update(bytes).digest('hex')});}
  await writeFile(join(root,'release-manifest.json'),JSON.stringify({version:'test',harness:'0.1.7-rc.2',packages}));
  const cli=join(root,'fake-dsh');await writeFile(cli,"#!/bin/sh\nprintf '0.1.7-rc.2\\n'\n",{mode:0o700});
  const home=join(root,'home'),profile=join(home,'profiles','workdsh');await mkdir(profile,{recursive:true});
  const previous=JSON.stringify({dependencies:{'workdsh-plugin-office':'existing'},dsh:{profile:{bundles:['workdsh-plugin-office']}}});
  await writeFile(join(profile,'package.json'),previous);
  const run=(extra=[])=>execFileSync(process.execPath,['scripts/install-project-release.mjs','--directory',root,'--dsh',cli,'--dry-run',...extra],{env:{...process.env,DSH_HOME:home},encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const output=run();
  for(const name of ['skills','experts','connectors','library'])assert.match(output,new RegExp('workdsh-plugin-'+name+'\\.tgz'));
  for(const name of ['office','projects','activity','enterprise-collaboration'])assert.ok(!output.includes('workdsh-plugin-'+name+'.tgz'));
  assert.match(output,/preserving its configuration/);
  assert.match(run(['--with','office,projects']),/workdsh-plugin-office\.tgz/);
  assert.throws(()=>run(['--with','enterprise-collaboration']),/installed separately/);
  await writeFile(join(root,'release-manifest.json'),JSON.stringify({version:'test',harness:'0.1.7-rc.2',packages,installation:{defaultPackages:['workdsh-provider-identity-enterprise']}}));
  assert.throws(()=>run(),/default installation policy does not match/);
  assert.equal(await readFile(join(profile,'package.json'),'utf8'),previous);
 }finally{await rm(root,{recursive:true,force:true});}
});
