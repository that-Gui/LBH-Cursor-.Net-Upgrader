# .NET 10 upgrade playbook

Pass this text **verbatim** as the original request to every engineering-implementation-loop handoff.

Upgrade this repository to .NET 10 (LTS).
- FIRST, before you edit anything: run 'dotnet build', then 'dotnet test', on the repository exactly as you found it, and record the fully-qualified name of every failing test. That is the BASELINE. Capture it before your first edit — do not reconstruct it afterwards by stashing your changes.
- Update global.json (if present) and every <TargetFramework>/<TargetFrameworks> value to net10.0, preserving OS-specific suffixes (e.g. net8.0-windows becomes net10.0-windows).
- Update NuGet package references to stable versions compatible with net10.0.
- Fix any resulting build or test breaks, including Dockerfile base images and SDK version pins.
- 'dotnet build' must pass. Then re-run 'dotnet test': every test still failing must already be in the baseline. A test that passed in the baseline and fails now is a regression — fix it. Tests that were already failing may stay failing.
- If the baseline build did not succeed there is no usable baseline, and the strict bar applies instead: both 'dotnet build' and 'dotnet test' must pass outright.
- Make no changes unrelated to the upgrade.
- In your summary, name every baseline failure you are carrying forward and why it fails, so a human can check the claim against the base branch.
- End your final summary with exactly these three lines, in this order, with nothing after them:
BASELINE_FAILURES: <how many baseline failures are still failing; 0 if none>
REVIEWERS: PASS (only if both reviewers returned PASS with zero Criticals) or REVIEWERS: FAIL otherwise
UPGRADE_RESULT: SUCCESS (only if the build passes and no test regressed against the baseline) or UPGRADE_RESULT: FAILED otherwise
