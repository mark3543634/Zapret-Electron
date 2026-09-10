param(
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$expectedCommit = 'f200e33fd283143a9f101d62aaf9d8c1468a23fe'
$buildRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('zapret-tg-ws-build-' + [guid]::NewGuid().ToString('N'))
$sourceRoot = Join-Path $buildRoot 'source'
$venvRoot = Join-Path $buildRoot 'venv'
$distRoot = Join-Path $buildRoot 'dist'
$workRoot = Join-Path $buildRoot 'work'

New-Item -ItemType Directory -Path $buildRoot | Out-Null
try {
    git clone --quiet --branch v1.10.2 --depth 1 https://github.com/Flowseal/tg-ws-proxy.git $sourceRoot
    $actualCommit = (git -C $sourceRoot rev-parse HEAD).Trim()
    if ($actualCommit -ne $expectedCommit) {
        throw "Unexpected tg-ws-proxy commit: $actualCommit"
    }

    & $Python -m venv $venvRoot
    $venvPython = Join-Path $venvRoot 'Scripts\python.exe'
    & $venvPython -m pip install --disable-pip-version-check --quiet pyinstaller==6.22.0 certifi cryptography==46.0.5

    $env:TG_WS_SOURCE = $sourceRoot
    & $venvPython -m PyInstaller --noconfirm --clean `
        --distpath $distRoot `
        --workpath $workRoot `
        (Join-Path $projectRoot 'vendor\tg-ws-proxy-headless.spec')

    Copy-Item -LiteralPath (Join-Path $distRoot 'TgWsProxy-headless.exe') `
        -Destination (Join-Path $projectRoot 'bin\TgWsProxy-headless.exe') -Force
    Write-Output "Built bin\TgWsProxy-headless.exe from tg-ws-proxy v1.10.2 ($expectedCommit)"
}
finally {
    Remove-Item Env:TG_WS_SOURCE -ErrorAction SilentlyContinue
    $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedBuild = [System.IO.Path]::GetFullPath($buildRoot)
    if ($resolvedBuild.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedBuild).StartsWith('zapret-tg-ws-build-')) {
        Remove-Item -LiteralPath $resolvedBuild -Recurse -Force -ErrorAction SilentlyContinue
    }
}
