# snapshot.ps1 — saves all src files into a single timestamped notepad file

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$outFile   = "build-snapshots\build_$timestamp.txt"

$header = @"
================================================================================
  BUILD SNAPSHOT — $timestamp
================================================================================

"@

$header | Out-File -FilePath $outFile -Encoding utf8

Get-ChildItem -Path "src" -Recurse -Include "*.js","*.jsx","*.ts","*.tsx","*.css" |
  Sort-Object FullName |
  ForEach-Object {
    $rel = $_.FullName.Substring((Get-Location).Path.Length + 1)
    @"

================================================================================
  FILE: $rel
================================================================================

"@ | Out-File -FilePath $outFile -Append -Encoding utf8
    Get-Content $_.FullName | Out-File -FilePath $outFile -Append -Encoding utf8
  }

Write-Host "Snapshot saved → $outFile"
