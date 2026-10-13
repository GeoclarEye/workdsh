# DSH Desktop repository rules

This repository owns WorkDSH Web and Desktop. Desktop and Web consume the same exact official DSH published package version. Desktop binary dependencies and command-management helpers are extracted from checksum-locked official release installers.

## Git branch and release policy

- Keep exactly one long-lived product branch: the GitHub default branch, currently `main`. Do not maintain `main` and `master` as parallel product or release lines.
- Development and migration branches are temporary. Bring every accepted change back to the default branch through a reviewed pull request; verify required checks and that the intended commits are present there before treating the work as delivered.
- Create Desktop release tags and publish product artifacts only from commits reachable from the default branch. A successful build on a temporary branch is validation, not a release.
- After a temporary branch has been merged and its changes verified on the default branch, delete that temporary branch. Retain an unmerged branch only while its work is still under review; do not delete unique history.
- If the default branch is renamed, update GitHub settings, CI, website deployment, release triggers, and documentation together before removing the old branch.

### Container deployment

- **`docker restart` cannot change a container's image.** To deploy a new build the container must be **recreated** (`docker rm` + `docker run` with the same name, ports, volume and environment). Restarting an old container makes `front.mjs` see the *old* release manifest, decide "version unchanged, skip install", and serve stale code while the log looks healthy.
- **Bumping a plugin's package version means three edits, not one.** The release version and the plugin's own version are in the repository, but the installer writes a third copy into the **volume** at `profiles/<profile>/package.json` as a hard-coded path (`"pkg": "file:/opt/workdsh/release/pkg-<version>.tgz"`). Raising the repository version without clearing that entry makes the next install fail with `ENOENT` on the old filename. Clear the stale entry before deploying a version bump.
- **Remove stale `profiles/<profile>/package.json.lock` before deploying.** A lock left by an interrupted install blocks every subsequent write: `atomic-write: timed out waiting for the writer lock`.
- **The installer has an ordering dependency.** During install the profile still references bundles that have not been added yet, so a profile carrying a broken bundle entry makes `--dump-config` fail and leave a lock. Clean the volume entries first; the installer does not do it.
- **Outbound network is the usual cause of a stuck install.** Measure it before blaming code: `curl -o /dev/null -w "%{speed_download}" https://registry.npmjs.org/`. On a China-region host this can read `200` with a few bytes per second, which looks like success but never finishes. When the Profile already carries a matching harness runtime, deploy with `WORKDSH_PACKAGES_ONLY=1` (front.mjs) / `--packages-only` (installer): it skips installing the official base and runtime, and installs only this release's local `.tgz` packages. The harness version check still runs, so a mismatched runtime is still rejected before anything is written.
- **Build images on the deployment host, not on the workstation.** A workstation image may be a different architecture than the host (`exec format error`) and may take many minutes just to pull its base layer. Deriving from the previous image already on the host is both fast and correct when the only change is the release payload: `FROM workdsh-web:<previous>` plus a `COPY` of the new `.artifacts/<release>/`.

### Upstream fork and commit conventions

- **`origin` is `techflag/workdsh` (upstream) and is not a target for routine work.** Product changes live on the fork `geoclar` = `git@github.com:GeoclarEye/workdsh.git`. Before any push, run `git merge-base --is-ancestor geoclar/main main` and confirm the push is a fast-forward; the fork may have moved.
- **Default to not contributing upstream.** When a piece of work is merged back into `main`, ask whether it should also be contributed to `techflag/workdsh` before opening any pull request there. Only open one when that answer is yes. Never infer it from the size or value of the change — whether a change is a product feature or a generic improvement is a product decision.
- **Every change, including a one-line bug fix, lands on a temporary branch** (`feat/<topic>` or `fix/<topic>`, cut from `main`) and returns through a merge commit. Editing `main` directly and pushing bypasses review, checks and the record of why the change exists. The exception is documentation and typo fixes, which commit straight to `main`.
- **Cut a release in its own commit, never mixed with a feature.** Bump **two** version numbers, both required: the Web release version in `apps/web/package.json` plus `RELEASE_DIR` in `apps/web/deploy/docker/Web.Dockerfile` decides whether `front.mjs`'s `needsInstall` runs the installer; and the plugin's own package version decides whether pnpm actually replaces the package. Bumping only the first yields a deployment that looks successful while serving stale code.
- **Commit messages follow three parts: symptom, root cause with evidence (file, line, measured number), and how it was verified.** Split refactors from behaviour fixes in separate commits so `git bisect` can separate them. See `5e461cf458` and `8d8ef1e0c5` for the house style.

## Prerequisites and setup

- Use Node.js `^22.19.0` or `>=24.0.0` and the root Yarn `4.18.0` release through Corepack.
- Install root dependencies with `corepack yarn install --immutable`.

## Build, run, and verify

- Start the desktop development workflow with `corepack yarn dev`.
- Build the desktop package with `corepack yarn build`.
- Run unit tests with `corepack yarn test`.
- Run type checking with `corepack yarn typecheck`.
- Run the complete headless gate with `corepack yarn check`.
- `apps/desktop/` is the only Desktop source and release workspace. Do not reintroduce a copied Beta package; optional release channels must build from this same source and pinned DSH version.
- The official release version locked in `upstream.json` is the single DSH version for the packaged WorkDSH Profile. Desktop source is an Electron carrier without direct DSH dependencies. A DSH upgrade is incomplete until `corepack yarn check:desktop-dsh-alignment`, the Desktop checks, and a packaged-runtime check pass. Default to the newest official stable DSH release after compatibility validation; use a pre-release only by explicit product decision. Do not tag a Desktop release while the version gate fails. The carrier must contain no second DSH installation.
- `apps/web/` owns Web launch, deployment and verification. Root `packages/` owns shared WorkDSH feature packages, and root `profiles/` owns composition. Its package manifests must declare the same exact DSH version as `upstream.json`; run `corepack yarn check:web-dsh-alignment` when either side changes. The Web workspace remains self-contained and does not import or modify the official source tree.

- `apps/desktop/` owns the Electron carrier, packaging, and release tests. DSH Host and Client code comes from the published official runtime Profile; WorkDSH features belong to the WorkDSH Profile packages.
- The Desktop workspace uses the root Yarn release with `nodeLinker: node-modules`. The nested `apps/web/` workspace retains its own pinned pnpm lockfile and package manager; run its commands from that directory. Do not install it into the root Yarn workspace.
- Keep presentation and WorkDSH feature changes in the Profile rather than adding a second Desktop Host or Client implementation.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.

## Personal and enterprise product boundary

- Personal Desktop, enterprise Desktop use one validated official DSH version and the same owned feature implementations. Preserve the complete official interface; never copy its settings, sidebar or right panel.
- Enterprise execution is Desktop-only: the official Host, Agent and tools run on the employee computer. Do not restore ECS member processes, a member gateway or remote session storage. Identity, storage, permissions and synchronization are explicit adaptations.
- There is one base Desktop installer. Enterprise account and collaboration plugins are installed explicitly, not shipped in the base runtime. Personal mode does not activate it. Projects are included in Desktop and Web. The server owns administration, authorization, collaboration data and model forwarding; collaboration activates only for authenticated enterprise members; personal mode must not activate it. Notifications and business applications remain optional external plugins.
- The administrator presets only the public backend origin in packaged `workdsh-config.json` via `WORKDSH_DEPLOYMENT_CONFIG`. Login credentials and model keys do not belong in this file.
- WorkDSH Admin owns accounts, organizations, authorization, audited member-visible conversation access and Spring AI internal model APIs. Members manually configure company API, internal Key, protocol and model catalog through official Custom Model API settings; personal providers can coexist. Do not restore enterprise model injection or synchronization.
- Preserve user-facing README content and organize new material in the corresponding sections. Development logs, raw acceptance evidence, credentials and generated packages are not submission content.

- Never clone, import or compile official DSH source as part of product builds. `upstream.json` locks published package versions and Desktop archive URLs, sizes and SHA-512 hashes. Extract only runtime dependencies, Office assets and prebuilt command helpers; do not carry a second official Electron application or DSH installation.

## Delivery regression gate

- Directory migrations must update scripts, CI working directories, test globs and deployment contexts together. Source-only moves are incomplete.
- Required plugin delivery must pass composition, archive dependency closure, installed runtime and actual UI checks. Builds alone are not acceptance.
- Shared feature changes must trigger Desktop and Web CI. Enterprise plugin installation never grants membership; authorization and inactive personal mode remain mandatory.
- Candidate handover requires actual packaged Desktop and backend operation results. Report missing acceptance explicitly; never call a candidate complete while required plugins or entries are missing.
