"""Check completed delivery archives without modifying the archives themselves."""
from pathlib import Path
import argparse, hashlib, json, re, zipfile
p=argparse.ArgumentParser();p.add_argument('out',type=Path);args=p.parse_args();out=args.out.resolve()
def digest(data):return hashlib.sha256(data).hexdigest()
records=[]
for name, directory, prefix, keys in [
 ('CodexAutoApproval-Windows-0.1.3.zip','CodexAutoApproval-Windows','CodexAutoApproval-Windows/', ['AUTO-REVIEW-BUILD.json','resources/glm/zcode.cjs','resources/glm/provider/zcode-builtin.json','resources/app.asar','ACCEPTANCE.md','CHECKS.json','docs/desktop-build-responses-2026-10-02.md','docs/responses-continuation-2026-10-02.md','evidence/responses-continuation-2026-10-02/live.json','evidence/build-responses-2026-10-02/windows/profile-cleanup.json','zcode-29628c9-auto-review.patch']),
 ('CodexAutoApproval-plugin-0.1.3.zip','local-marketplace','', ['marketplace.json','plugins/codex-auto-approval/.zcode-plugin/plugin.json','ACCEPTANCE.md','CHECKS.json','responses-continuation-2026-10-02.md','evidence/responses-continuation-2026-10-02/live.json'])]:
 with zipfile.ZipFile(out/name) as z:
  names=z.namelist();assert len(names)==len(set(names)), 'Duplicate entries'
  assert not any('/profile/' in n or 'asar-staging' in n for n in names), 'Private profile or temporary staging included'
  corrupt=z.testzip();assert corrupt is None,corrupt
  hashes={}
  for key in keys:
   actual=z.read(prefix+key);expected=(out/directory/key).read_bytes();assert actual==expected,key;hashes[key]=digest(actual)
  for key in ['ACCEPTANCE.md','CHECKS.json']:assert z.read(prefix+key)==(out/key).read_bytes(),key
  records.append({'file':name,'crcPassed':True,'duplicates':0,'entryCount':len(names),'size':(out/name).stat().st_size,'criticalFilesMatchCurrentDelivery':True,'profileOrTemporaryStagingIncluded':False,'criticalSha256':hashes})
links=[]
for directory in [out,out/'CodexAutoApproval-Windows',out/'CodexAutoApproval-Windows/docs',out/'local-marketplace']:
 for report in ['ACCEPTANCE.md','desktop-build-responses-2026-10-02.md','responses-continuation-2026-10-02.md']:
  file=directory/report
  if not file.exists():continue
  for link in re.findall(r'\]\(([^)]+)\)',file.read_text()):
   if '://' in link or link.startswith('#'):continue
   assert (file.parent/link.split('#')[0]).exists(),f'Broken link {file}: {link}'
   links.append({'document':str(file.relative_to(out)),'target':link})
checks=json.loads((out/'CHECKS.json').read_text());assert (out/checks['receiptBase']).is_dir()
for field in ['sourceTests','sourceLiveResponses']:assert (out/checks[field]['reference']).exists()
for receipt in checks['receipts']:assert (out/checks['receiptBase']/receipt).exists()
for line in (out/'SHA256SUMS.txt').read_text().splitlines():
 sha,name=line.split('  ',1)
 with (out/name).open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==sha,name
result={'archives':records,'relativeDocumentLinksPassed':True,'documentLinks':links,'machineReceiptPathsPassed':True,'sha256ManifestPassed':True,'note':'This sidecar checks completed ZIP files; it is intentionally outside those ZIP files.'}
(out/'archive-validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'archivesPassed':len(records),'relativeLinksPassed':len(links),'sha256ManifestPassed':True}))
