"""Verify the pinned policy and replay the complete patch against clean source files."""
from pathlib import Path
import hashlib
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HOST = ROOT / "host-adapter/upstream"
CODEX = ROOT.parent / "codex"
OUT = ROOT / "artifacts/acceptance"
OUT.mkdir(parents=True, exist_ok=True)
def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd)

policy_source = git(CODEX, "show", "d42056091aded7feb1d88ac7e83972108b2aa478:codex-rs/prompts/templates/guardian/policy.md")
policy_copy = (ROOT / "prompts/policy.md").read_bytes().split(b"\n", 1)[1]
normalize = lambda data: data.replace(b"\r\n", b"\n")
assert normalize(policy_source) == normalize(policy_copy), "Policy body differs from the pinned Codex policy"
(OUT / "policy-comparison.json").write_text(json.dumps({
    "codexCommit": "d42056091aded7feb1d88ac7e83972108b2aa478",
    "source": "codex-rs/prompts/templates/guardian/policy.md", "copy": "prompts/policy.md",
    "normalization": "CRLF to LF; remove the added one-line source comment",
    "bodyIdentical": True, "bodySha256": hashlib.sha256(normalize(policy_source)).hexdigest(),
}, indent=2) + "\n")

commit = git(HOST, "rev-parse", "HEAD").decode().strip()
assert commit == "29628c9acdb81b703bbd4080c207a0e7ce5e276e"
patch = ROOT / "host-adapter/zcode-29628c9-auto-review.patch"
tracked = git(HOST, "diff", "--name-only").decode().splitlines()
added = git(HOST, "ls-files", "--others", "--exclude-standard").decode().splitlines()
with tempfile.TemporaryDirectory(prefix="zcode-clean-patch-") as temporary:
    clean = Path(temporary)
    for file in tracked:
        target = clean / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git(HOST, "show", f"HEAD:{file}"))
    subprocess.run(["git", "apply", "--check", str(patch)], cwd=clean, check=True)
    subprocess.run(["git", "apply", str(patch)], cwd=clean, check=True)
    produced = {file.relative_to(clean).as_posix() for file in clean.rglob("*") if file.is_file()}
    assert produced == set(tracked + added), "Patch contains unexpected generated or missing files"
    for file in tracked + added:
        assert normalize((clean / file).read_bytes()) == normalize((HOST / file).read_bytes()), file
(OUT / "patch-validation.json").write_text(json.dumps({
    "upstreamCommit": commit, "cleanApplyCheck": True, "appliedFilesMatchWorkspace": True,
    "patchSha256": hashlib.sha256(patch.read_bytes()).hexdigest(), "files": tracked + added,
}, indent=2) + "\n")
print("Pinned policy identical; complete patch applies cleanly and reproduces all modified files.")
