"""Run the repository lint rules on changed files and their pinned baselines."""
from pathlib import Path
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HOST = ROOT / "host-adapter/upstream"
OUT = ROOT / "artifacts/acceptance"
git = lambda *args: subprocess.check_output(["git", *args], cwd=HOST)
config_text = (HOST / ".oxlintrc.json").read_text()
config = json.loads("\n".join(line for line in config_text.splitlines() if not line.lstrip().startswith("//")))
config.pop("ignorePatterns", None)
config.pop("$schema", None)
config_file = OUT / "changed-lint-config.json"
config_file.write_text(json.dumps(config))
tracked = [file for file in git("diff", "--name-only").decode().splitlines() if file.endswith(".ts")]
added = [file for file in git("ls-files", "--others", "--exclude-standard").decode().splitlines() if file.endswith(".ts")]
command = [str(HOST / "node_modules/.bin/oxlint"), "--config", str(config_file), "--no-ignore"]
def run(files, cwd, log):
    result = subprocess.run(command + files, cwd=cwd, capture_output=True, text=True)
    (OUT / "logs" / log).write_text(result.stdout + result.stderr)
    return result.returncode

changed_result = run(tracked + added, HOST, "changed-lint.log")
new_result = run(added, HOST, "new-files-lint.log")
with tempfile.TemporaryDirectory(prefix="zcode-lint-baseline-") as temporary:
    baseline = Path(temporary)
    for file in tracked:
        target = baseline / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git("show", f"HEAD:{file}"))
    baseline_result = run(tracked, baseline, "baseline-changed-files-lint.log")
(OUT / "lint-comparison.json").write_text(json.dumps({
    "changedExitCode": changed_result, "newFilesExitCode": new_result,
    "baselineChangedFilesExitCode": baseline_result, "trackedFiles": tracked, "newFiles": added,
    "configuration": "Repository rules, removing only ancestor ignorePatterns so Agent sources are checked",
}, indent=2) + "\n")
print(json.dumps({"changedExitCode": changed_result, "newFilesExitCode": new_result, "baselineExitCode": baseline_result}))
if new_result:
    raise SystemExit(new_result)
