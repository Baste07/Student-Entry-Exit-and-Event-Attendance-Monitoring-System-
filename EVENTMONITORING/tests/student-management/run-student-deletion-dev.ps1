$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$ref = (Get-Content -LiteralPath (Join-Path $root 'supabase/.temp/project-ref') -Raw).Trim()
if ($ref -ne 'ehyqvyglirirktfmdezq') { throw 'Refusing deletion fixtures outside the reviewed development project.' }
$migration = Get-Content -LiteralPath (Join-Path $root 'EVENTMONITORING/database/migrations/20261026224317_student_deletion_transaction.sql') -Raw
$tests = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'student-deletion.dev.sql') -Raw
$body = $migration -replace '(?m)^begin;\r?\n', '' -replace '(?m)^commit;\r?\n?', ''
$file = Join-Path ([IO.Path]::GetTempPath()) ('student-deletion-' + [guid]::NewGuid() + '.sql')
try {
    [IO.File]::WriteAllText($file, "begin;`n$body`n$tests`nrollback;`n")
    & supabase db query --linked --workdir $root --file $file --output json
    if ($LASTEXITCODE -ne 0) { throw 'Development deletion tests failed.' }
} finally {
    Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
}
