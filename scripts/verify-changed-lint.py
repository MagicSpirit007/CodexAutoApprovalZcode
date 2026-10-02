"""Compare changed-file lint with HEAD and the preserved local 0.1.2 patch."""
from pathlib import Path
import json
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HOST = ROOT / "host-adapter/upstream"
OUT = ROOT / "artifacts/0.1.3/acceptance"
PATCH = OUT / "preexisting/host-0.1.2.patch"
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "logs").mkdir(parents=True, exist_ok=True)


def git(*args):
    return subprocess.check_output(["git", *args], cwd=HOST)


config_text = (HOST / ".oxlintrc.json").read_text()
config = json.loads("\n".join(line for line in config_text.splitlines() if not line.lstrip().startswith("//")))
config.pop("ignorePatterns", None)
config.pop("$schema", None)
config_file = OUT / "changed-lint-config.json"
config_file.write_text(json.dumps(config))
tracked = [file for file in git("diff", "--name-only").decode().splitlines() if file.endswith((".ts", ".tsx"))]
added = [file for file in git("ls-files", "--others", "--exclude-standard").decode().splitlines() if file.endswith((".ts", ".tsx"))]
command = [str(HOST / "node_modules/.bin/oxlint"), "--config", str(config_file), "--no-ignore"]


def run(files, cwd, log):
    if not files:
        (OUT / "logs" / log).write_text("No matching files; lint not invoked.\n")
        return 0
    result = subprocess.run(command + files, cwd=cwd, capture_output=True, text=True)
    (OUT / "logs" / log).write_text(result.stdout + result.stderr)
    return result.returncode


# The preserved patch is required evidence; silently using HEAD would misclassify
# earlier local changes as new 0.1.3 failures.
if not PATCH.is_file():
    raise SystemExit(f"Missing preserved 0.1.2 baseline patch: {PATCH}")
patch_paths = [line.split("\t", 2)[2] for line in git("apply", "--numstat", str(PATCH)).decode().splitlines()]
changed_result = run(tracked + added, HOST, "changed-lint.log")
with tempfile.TemporaryDirectory(prefix="zcode-lint-baseline-") as temporary:
    baseline = Path(temporary)
    paths = sorted(set(tracked + patch_paths))
    # Read immutable HEAD blobs in one git process; Windows-mounted workspaces
    # make one subprocess per baseline file needlessly expensive.
    blobs = subprocess.check_output(["git", "cat-file", "--batch"], cwd=HOST,
                                    input="".join(f"HEAD:{file}\n" for file in paths).encode())
    offset = 0
    originals = {}
    for file in paths:
        end = blobs.index(b"\n", offset)
        header = blobs[offset:end].split()
        offset = end + 1
        if header[-1] == b"missing":
            originals[file] = None
            continue
        size = int(header[-1])
        originals[file] = blobs[offset:offset + size]
        offset += size + 1
    for file in paths:
        # A patch must never write beyond the isolated baseline directory.
        target = baseline / file
        if not target.resolve().is_relative_to(baseline.resolve()):
            raise SystemExit(f"Unsafe baseline patch path: {file}")
        original = originals[file]
        if original is None:
            # Files introduced by the preserved patch have no HEAD contents.
            if file in tracked:
                raise SystemExit(f"Cannot read tracked baseline file: {file}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(original)
    head_result = run(tracked, baseline, "baseline-changed-files-lint.log")
    apply = subprocess.run(["git", "apply", "--unsafe-paths", str(PATCH)], cwd=baseline, capture_output=True, text=True)
    (OUT / "logs" / "preserved-baseline-apply.log").write_text(apply.stdout + apply.stderr)
    if apply.returncode:
        raise SystemExit("Cannot reconstruct preserved 0.1.2 baseline; see preserved-baseline-apply.log")
    preserved_files = [file for file in tracked + added if (baseline / file).is_file()]
    genuinely_new = [file for file in added if not (baseline / file).is_file()]
    preserved_result = run(preserved_files, baseline, "preserved-0.1.2-changed-files-lint.log")
new_result = run(genuinely_new, HOST, "new-files-lint.log")
all_untracked_result = run(added, HOST, "all-untracked-files-lint.log")
def errors(log):
    diagnostics = {}
    for block in re.split(r"\n  (?=[x!])", (OUT / "logs" / log).read_text()):
        if not block.startswith("x "):
            continue
        message = block.splitlines()[0]
        rule = re.match(r"x ([^:]+):", message)
        location = re.search(r",-\[([^\]]+):\d+:\d+\]", block)
        if rule and location:
            # Location/line-count shifts do not turn an existing max-lines error
            # into a new diagnostic; report full messages separately for review.
            key = f"{location.group(1)}::{rule.group(1)}"
            diagnostics[key] = message
    return diagnostics


current_errors = errors("changed-lint.log")
head_errors = errors("baseline-changed-files-lint.log")
preserved_errors = errors("preserved-0.1.2-changed-files-lint.log")
summary = {
    "currentErrors": current_errors,
    "headBaselineErrors": head_errors,
    "preserved012BaselineErrors": preserved_errors,
    "newErrorKeysComparedToHead": sorted(current_errors.keys() - head_errors.keys()),
    "newErrorKeysComparedToPreserved012": sorted(current_errors.keys() - preserved_errors.keys()),
    "changedExitCode": changed_result,
    "newFilesExitCode": new_result,
    "allUntrackedFilesExitCode": all_untracked_result,
    "baselineChangedFilesExitCode": head_result,
    "headBaselineChangedFilesExitCode": head_result,
    "preserved012BaselineChangedFilesExitCode": preserved_result,
    "preserved012Patch": str(PATCH.relative_to(ROOT)),
    "trackedFiles": tracked,
    "newFiles": genuinely_new,
    "allUntrackedFiles": added,
    "preserved012Files": preserved_files,
    "configuration": "Repository rules, removing only ancestor ignorePatterns so Agent sources are checked",
    "interpretation": "HEAD and preserved 0.1.2 are separate baselines. New files exclude paths already introduced by the preserved patch. Compare diagnostic logs to attribute changed-file failures; exit codes alone do not establish equivalence.",
}
(OUT / "lint-comparison.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({key: value for key, value in summary.items() if key.endswith("ExitCode")}))
if new_result:
    raise SystemExit(new_result)
