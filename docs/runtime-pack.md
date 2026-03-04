# Custom Runtime Pack

## Per-commit benchmarking

To benchmark a specific dotnet/runtime commit that doesn't have a published SDK:

```bash
# Resolve and download the closest runtime pack for a commit
node scripts/resolve-runtime-pack.mjs <runtime-commit-hash>

# Full pipeline with custom runtime pack
node scripts/run-pipeline.mjs --runtime-commit <runtime-commit-hash>

# Or manually set the env var for build-app.sh
export CUSTOM_RUNTIME_PACK_DIR=/path/to/extracted/nupkg
./scripts/build-app.sh empty-browser mono debug
```

### How it works

1. The script queries the public `dotnet11` NuGet feed on Azure Artifacts for
   `Microsoft.NETCore.App.Runtime.Mono.browser-wasm` package versions
2. For each candidate, it reads `Microsoft.NETCore.App.versions.txt` to get the
   VMR (dotnet/dotnet) commit, then resolves the runtime commit from
   `src/source-manifest.json`
3. Uses the GitHub compare API to find the closest pack that includes the target commit
4. Downloads and extracts the `.nupkg`
5. The MSBuild `UpdateRuntimePack` target in `Directory.Build.targets` overrides
   the SDK's bundled runtime pack with the custom one

### Strategies

- `closest-after` (default) — first pack whose runtime commit includes the target
- `closest-before` — last pack built before the target commit
- `exact` — only if the pack was built from exactly that commit

## MSBuild target (manual)

This allows using a custom runtime pack without the resolver script:

```xml
  <Target Name="UpdateRuntimePack" AfterTargets="ResolveFrameworkReferences">
    <ItemGroup>
      <ResolvedRuntimePack PackageDirectory="d:\runtime\artifacts\bin\microsoft.netcore.app.runtime.browser-wasm\Release"
                           Condition="'%(ResolvedRuntimePack.FrameworkName)' == 'Microsoft.NETCore.App'" />
    </ItemGroup>
  </Target>
```

Or pass via command line:

```bash
dotnet publish /p:CustomRuntimePackDir=/path/to/extracted/pack
```