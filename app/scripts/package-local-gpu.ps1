param(
    [Parameter(Mandatory)][string]$ArtifactRoot,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if (!$OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot '../eval-data/local-gpu-release' }
$source = [IO.Path]::GetFullPath($ArtifactRoot)
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null

function Copy-Verified($RelativePath, $Destination, $ExpectedHash) {
    $inputFile = Join-Path $source $RelativePath
    if ((Get-FileHash -LiteralPath $inputFile -Algorithm SHA256).Hash -ne $ExpectedHash) {
        throw "Source checksum mismatch: $RelativePath"
    }
    Copy-Item -LiteralPath $inputFile -Destination $Destination
}

function New-Bundle($Name, $IncludeSherpa) {
    $stage = Join-Path $output $Name
    if (Test-Path -LiteralPath $stage) { throw "Staging directory already exists: $stage" }
    New-Item -ItemType Directory -Force -Path "$stage/runtime/bin", "$stage/licenses" | Out-Null
    Copy-Item -LiteralPath "$PSScriptRoot/../docs/local-gpu-notices.md" -Destination "$stage/NOTICE.md"
    Invoke-WebRequest 'https://www.apache.org/licenses/LICENSE-2.0.txt' -UseBasicParsing -OutFile "$stage/licenses/Apache-2.0.txt"
    if ($IncludeSherpa) {
        Copy-Verified 'unified-lowbit/gpu-w4-g32/encoder.onnx' $stage 'fa0163705409d0047a132e11ec6c13b4a945b41d7ea2c781f79b89993ea79703'
        Copy-Verified 'unified-lowbit/gpu-w4-g32/decoder.onnx' $stage 'c31c063cffc978d19a0564eb31c63d131f1352ddedbd2b9c4559635b225cdcc1'
        Copy-Verified 'unified-lowbit/gpu-w4-g32/joiner.onnx' $stage '1e09b15a71aeede79442ace27092d0690af323e50c210d609dc41bc11b60be97'
        Copy-Verified 'unified-lowbit/gpu-w4-g32/tokens.txt' $stage 'dc0b4584ab2e4ddbf888425c076c61b736e7356a015250db7d307e6f1a8188ff'
        Copy-Item -LiteralPath "$source/unified-lowbit/gpu-w4-g32/conversion.json" -Destination $stage
        # Pinned, tested Node binding and CUDA native libraries, isolated from the CPU package.
        Copy-Item -LiteralPath "$source/runtime-node/node_modules/sherpa-onnx-node" -Destination "$stage/runtime" -Recurse
        Copy-Item -LiteralPath "$source/runtime-node/node_modules/sherpa-onnx-win-x64" -Destination "$stage/runtime" -Recurse
        Invoke-WebRequest 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' -UseBasicParsing -OutFile "$stage/licenses/NVIDIA-Open-Model-License.html"
        Invoke-WebRequest 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/LICENSE' -UseBasicParsing -OutFile "$stage/licenses/ONNX-Runtime-LICENSE.txt"
        $families = @('cuda_runtime', 'cublas', 'cuda_nvrtc', 'cudnn')
    } else {
        Copy-Verified 'granite470/granite-speech-5.0-470m-turboctc-Q4_K_M.gguf' "$stage/model.gguf" '3f30525381d72246b7f99e49b6cb66b249cf1b990c6c3d0e031a7765735f513e'
        Copy-Item -LiteralPath "$source/granite470/native-cuda/transcribe-native-windows-x86_64-cuda" -Destination "$stage/runtime/transcribe" -Recurse
        Copy-Item -LiteralPath "$source/transcribe-node/node_modules/transcribe-cpp/LICENSE" -Destination "$stage/licenses/transcribe-cpp-LICENSE.txt"
        Invoke-WebRequest 'https://raw.githubusercontent.com/ggml-org/ggml/master/LICENSE' -UseBasicParsing -OutFile "$stage/licenses/ggml-LICENSE.txt"
        $families = @('cuda_runtime', 'cublas')
    }
    foreach ($family in $families) {
        Copy-Item "$source/cuda-deps/nvidia/$family/bin/*.dll" -Destination "$stage/runtime/bin"
    }
    Get-ChildItem -LiteralPath "$source/cuda-deps" -Directory -Filter '*.dist-info' | ForEach-Object {
        if (Test-Path -LiteralPath "$($_.FullName)/licenses") {
            Copy-Item -LiteralPath "$($_.FullName)/licenses" -Destination "$stage/licenses/$($_.Name)" -Recurse
        }
    }
    # Preserve binary identity and normalize archive member timestamps.
    Get-ChildItem -LiteralPath $stage -Recurse | ForEach-Object {
        $_.LastWriteTimeUtc = [DateTime]'2026-11-01T00:00:00Z'
    }
    $archive = Join-Path $output "$Name.tar.bz2"
    & tar.exe -cjf $archive -C $output $Name
    if ($LASTEXITCODE -ne 0) { throw "Archive creation failed: $Name" }
    [PSCustomObject]@{
        name = "$Name.tar.bz2"
        bytes = (Get-Item -LiteralPath $archive).Length
        installedBytes = (Get-ChildItem -LiteralPath $stage -File -Recurse | Measure-Object Length -Sum).Sum
        sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

@(
    New-Bundle 'parakeet-unified-en-cuda-w4g32-1' $true
    New-Bundle 'granite-470m-q4-cuda-1' $false
) | ConvertTo-Json -Depth 3
