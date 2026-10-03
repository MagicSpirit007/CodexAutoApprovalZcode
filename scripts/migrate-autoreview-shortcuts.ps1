param(
  [string]$OldExecutable = 'D:\CodexAutoReview\zcode\artifacts\0.1.3\CodexAutoApproval-Windows\ZCode.exe',
  [string]$InstalledExecutable = 'D:\CodexAutoReview\zcode\runtime\ZCodeAutoReview\ZCodeAutoReview.exe',
  [string]$Receipt = 'D:\CodexAutoReview\zcode\runtime\shortcut-migration.json',
  [switch]$Preview
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $InstalledExecutable -PathType Leaf)) { throw 'Run the independent installer before migrating shortcuts.' }
$shell = New-Object -ComObject WScript.Shell
$folders = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonStartMenu'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'))
$changed = @()
foreach ($folder in ($folders | Select-Object -Unique)) {
  if (-not $folder -or -not (Test-Path -LiteralPath $folder)) { continue }
  foreach ($file in (Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -File)) {
    $shortcut = $shell.CreateShortcut($file.FullName)
    if (-not $shortcut.TargetPath) { continue }
    if (-not [string]::Equals([IO.Path]::GetFullPath($shortcut.TargetPath), [IO.Path]::GetFullPath($OldExecutable), [StringComparison]::OrdinalIgnoreCase)) { continue }
    # Match only the exact old adapted executable; preserve other shortcuts.
    $changed += @{ shortcut = $file.FullName; oldTarget = $shortcut.TargetPath; newTarget = $InstalledExecutable;
      arguments = $shortcut.Arguments; oldWorkingDirectory = $shortcut.WorkingDirectory; oldIcon = $shortcut.IconLocation }
    if (-not $Preview) {
      Copy-Item -LiteralPath $file.FullName -Destination ($file.FullName + '.autoreview-backup') -ErrorAction Stop
      $shortcut.TargetPath = $InstalledExecutable
      $shortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($InstalledExecutable)
      $shortcut.IconLocation = $InstalledExecutable + ',0'
      $shortcut.Save()
    }
  }
}
if (-not $Preview) {
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($Receipt)) | Out-Null
  @{ migratedAt = [DateTime]::UtcNow.ToString('o'); shortcuts = $changed } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Receipt -Encoding UTF8
}
$changed | ConvertTo-Json -Depth 5
