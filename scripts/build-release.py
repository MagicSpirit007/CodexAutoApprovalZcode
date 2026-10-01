"""Stage self-contained local delivery archives; never touches the original install."""
from pathlib import Path
import hashlib
import json
import filecmp
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts"
MARKET = OUT / "local-marketplace"
PLUGIN = ROOT / "plugins/codex-auto-approval"
DESKTOP = OUT / "CodexAutoApproval-Windows"
PATCH = ROOT / "host-adapter/zcode-29628c9-auto-review.patch"

def copy_if_changed(source, destination):
    # Windows may hold an unchanged bundled executable open; no rewrite is needed.
    if Path(destination).is_file() and filecmp.cmp(source, destination, shallow=False):
        return str(destination)
    return shutil.copy2(source, destination)

for required in [PLUGIN / "runtime/node.exe", PLUGIN / "runtime/LICENSE-node.txt",
                 DESKTOP / "resources/glm/zcode.cjs", PATCH,
                 ROOT / "docs/desktop-acceptance.md"]:
    if not required.is_file():
        raise SystemExit(f"Missing delivery input: {required}")
MARKET.mkdir(parents=True, exist_ok=True)
shutil.copy2(ROOT / "marketplace.json", MARKET / "marketplace.json")
shutil.copytree(PLUGIN, MARKET / "plugins/codex-auto-approval", dirs_exist_ok=True, copy_function=copy_if_changed)
shutil.copytree(ROOT / "docs", MARKET / "docs", dirs_exist_ok=True)
(MARKET / "INSTALL.md").write_text(
    "# CodexAutoApproval 安装\n\n直接运行配套适配桌面的 ZCode.exe，打开本地工作区。"
    "在桌面插件市场添加本目录；安装并启用 CodexAutoApproval，"
    "新建会话，选择权限菜单中的 CodexAutoApproval。选择原生权限会在当前工作区停用本插件。\n\n停用或卸载可恢复原生人工审批。"
    "验收范围与固定提交差异见 docs/desktop-acceptance.md 和 docs/migration.md。\n",
    encoding="utf-8")
shutil.copy2(PATCH, OUT / PATCH.name)

def archive(directory, destination, prefix=""):
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for file in sorted(directory.rglob("*")):
            if file.is_file():
                output.write(file, prefix + file.relative_to(directory).as_posix())
    print(f"Created {destination.name}: {destination.stat().st_size:,} bytes", flush=True)

version = json.loads((PLUGIN / ".zcode-plugin/plugin.json").read_text())["version"]
plugin_zip = OUT / f"CodexAutoApproval-plugin-{version}.zip"
desktop_zip = OUT / f"CodexAutoApproval-Windows-{version}.zip"
archive(MARKET, plugin_zip)
archive(DESKTOP, desktop_zip, "CodexAutoApproval-Windows/")
files = [plugin_zip, desktop_zip, OUT / PATCH.name]
lines = []
for file in files:
    with file.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    lines.append(f"{digest}  {file.name}\n")
(OUT / "SHA256SUMS.txt").write_text("".join(lines), encoding="utf-8")
print(json.dumps({"archives": [file.name for file in files], "checksumFile": "SHA256SUMS.txt"}))
