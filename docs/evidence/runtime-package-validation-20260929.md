# Windows runtime package validation — 2026-09-29

Status: **local package build PASS; not a release candidate**. The build used
commit `9d3d1ad23133dc49d3d3329eac9f6a2eddcdf87f` with a dirty working tree.
The Windows migration and current uninstaller changes are not yet committed to
`origin/main`; no installer signature or independent supply-chain sign-off was
produced.

## Build evidence — production-pruned runtime

Command: `.\deployment\windows\build-runtime.ps1 -OutputDirectory <new temporary directory>`

The script exited successfully and completed:

- dependency install, root and Console type checks;
- 220-file FsGuard import scan and runtime secret scan;
- production Console/Vite build and `better-sqlite3` native smoke test;
- pinned tunnel archive verification and tunnel-client version check;
- SPDX-2.3 SBOM generation and runtime payload fingerprinting.

| Item | Result |
| --- | --- |
| Source manifest | 458 files; SHA-256 `e4c4d9d0546f07865dc60c065026bf613039183dad4b223856eba8baa816d180` |
| Runtime build ID | `sha256:e4c4d9d0546f07865dc60c065026bf613039183dad4b223856eba8baa816d180` |
| Runtime payload | 5,291 files; SHA-256 `2754fcc13c7e42c44d1fe8376f799a685cead70486cf0e53f09d61f3c1b5dcec` |
| SPDX production SBOM | 156 packages; SHA-256 `e9ad2567509013370fb7fc99ae73fb29bc91edf7c395470d942d79a91d9fc384` |
| Locked dependencies | SHA-256 `65e046dfd8360925f9204d36feec3747ecd9b1e0faf0aeff7ba1ce9f4982f561` |
| Packaged uninstaller | SHA-256 `6152DDD5462AF920A45FCED32B92D53EE3EB8CFC8A4523FFE056FEADE13EFA69`; identical to the tested source at build time |
| Packaged launcher | SHA-256 `E42B63EBDB43A943CDDDDD8AD368ED7E17C4563CAFBE67E249B9C9BDAF315A37`; identical to the tested source launcher |
| Secret/test-fixture checks | project `.env` absent; all test sources and generated fixtures removed; secret scan passed |
| Runtime dependency checks | `tsx` retained; test/dev modules including `abbrev` and `nopt` absent; post-prune TypeScript and SQLite smoke tests passed |
| Packaged launcher | `.lwb-runtime-package` marker, `.lwb-build-info.json`, and Console `dist/index.html` present; `.env`, `tests`, `vitest`, `@vue/test-utils`, `abbrev`, and `nopt` absent; `tsx` retained |
| Launcher preflight | A temporary fake `.env` with placeholder-only values was created in the package root, `Start-LocalWebGPT.ps1 -ValidateOnly` returned exit 0 and did not echo values, then the fake file was removed and absence verified. No daemon, Tunnel, or network operation was started. |
| Build identity / tool descriptions | `.lwb-build-info.json` binds `LWB_BUILD_ID` to the source manifest fingerprint; the packaged `packages/contracts/src/tools.ts` contains the new mandatory `summary`/`idempotency_key` guidance. |

Tunnel inputs were pinned to tunnel-client `v0.0.15`; the archive hash matched
`3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1`. The
packaged tunnel-client reported `0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0`.

## Compatibility caveat

The build host used Node.js `v22.20.0` and npm `10.9.3`. `npm ci` emitted
`EBADENGINE` warnings for `abbrev@5.0.0` and `nopt@10.0.1` while installing
Console's development test dependency `@vue/test-utils`; those test/dev modules
and all test sources are now removed from the final runtime. `tsx` remains a
production dependency, and the post-prune source-module plus SQLite smoke tests
passed. The warnings describe the build-time development environment, not the
installed production dependency set.

This verifies package construction from the current local tree only. It does
not verify signed installation, upgrade/rollback, deployed service behavior,
or public distribution.
