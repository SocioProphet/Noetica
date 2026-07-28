# Noetica distribution playbook

Every channel we ship (or want to ship) Noetica through, its current state, the exact steps
to publish, and — importantly — **which steps need a human account/secret that CI can't do**.

App identity:
- **Tauri bundle id:** `ai.noetica.app` (used inside the app; do not change lightly).
- **Store app id (Flathub/AppStream/Snap):** `ai.noetica.Noetica` — Flathub forbids IDs ending
  in `.app`, so the store id differs from the bundle id on purpose.
- **License:** MIT (`/LICENSE`), declared in every manifest.

Legend: ✅ live · 🟡 scaffold ready, needs a human/one-time step · 🔴 needs real build work.

---

## macOS

| Channel | State | Notes |
|---|---|---|
| Homebrew cask (`noetica`, `noetica-nightly`) | ✅ live | Auto-updated by `release.yml` on every stable + nightly. `brew install --cask SocioProphet/tap/noetica`. |
| Direct `.dmg` | ✅ live | Signed + notarized in CI. |

## Windows

| Channel | State | Steps / blocker |
|---|---|---|
| Direct `.exe` (NSIS) | ✅ live | Built + attached by `release.yml`. |
| winget | 🟡 | `release.yml`'s `update-winget` job **fails on the first-ever submission** — the initial package must be hand-authored + PR'd to `microsoft/winget-pkgs` once (see `packaging/winget/`, currently stale at 0.4.11 → bump to 0.4.24). After the first merge, CI's `wingetcreate update` owns every release. **Needs:** a `WINGET_PAT` secret + the one-time manual PR. |
| Chocolatey | 🟡 | `packaging/chocolatey/` nuspec + scripts exist, stale at 0.4.11. Bump to 0.4.24, `choco pack`, `choco push`. **Needs:** a Chocolatey API key + the one-time package approval. |

## Linux — no-sandbox channels (do these first; best effort:reward)

| Channel | State | Steps / blocker |
|---|---|---|
| Direct `.deb` / `.rpm` | ✅ live | Built + attached by `release.yml`. |
| **apt/dnf repo** (`apt install noetica`) | 🔴 **top priority** | We already build the deb/rpm — the missing piece is *hosting them as a repo*. Recommended: a CI job that publishes a signed apt + dnf repo to GitHub Pages (or Cloudsmith free OSS tier) from each release's packages. Zero sandbox rework, no store approval. **Needs:** a GPG signing key (repo secret) and a `gh-pages`/hosting target. |
| **AUR** (`noetica-bin`) | 🟡 ready | `packaging/linux/aur/PKGBUILD` installs from the release `.deb`. Fill the real `sha256sums` (`updpkgsums`), `makepkg --printsrcinfo > .SRCINFO`, then `git push` to `ssh://aur@aur.archlinux.org/noetica-bin.git`. **Needs:** an AUR account + SSH key. |

## Linux — app stores (harder; sandbox + approval)

| Channel | State | Steps / blocker |
|---|---|---|
| **Snap Store** | 🟡 scaffold | `packaging/linux/snap/snapcraft.yaml` rewritten as the **desktop app** on `classic` confinement (strict can't run the downloaded model runtime / GPU). **Needs:** (1) `snapcraft register noetica` (name is globally unique — grab it), (2) a **manual classic-confinement review** request on forum.snapcraft.io, (3) a local `snapcraft --use-lxd` build to validate, (4) `snapcraft upload`. Not yet build-tested. |
| **Flathub** | 🔴 real work | `metainfo` + `.desktop` are Flathub-compliant now (`ai.noetica.Noetica`). Remaining: (a) **verify `noetica.ai`** via `https://noetica.ai/.well-known/org.flathub.VerifiedApps.txt`; (b) rework the manifest so the **model-runtime-download + sidecar exec** works inside the Flatpak sandbox (bundle the runtime or ship as an extension) — this is the actual project; (c) host ≥1 real **screenshot**; (d) read the **Generative-AI policy** (Noetica is an AI app — real rejection risk); (e) PR to `flathub/flathub` (`new-pr` branch). |

---

## Recommended execution order

1. **apt/dnf repo** — biggest real reach for least work; reuses artifacts we already build.
2. **AUR** — minutes, once you create the AUR account.
3. **winget first-submission + Chocolatey bump** — Windows breadth; both just need their one-time manual submit + a secret.
4. **Snap** (classic) — register the name, request review, validate the build.
5. **Flathub** — schedule as a deliberate mini-project (runtime-in-sandbox + AI policy).

## Human/account checklist (things CI cannot do for you)

- [ ] `WINGET_PAT` secret + one-time `microsoft/winget-pkgs` PR
- [ ] Chocolatey API key + one-time package approval
- [ ] GPG key for the apt/dnf repo + a hosting target (GH Pages / Cloudsmith)
- [ ] AUR account + SSH key
- [ ] `snapcraft register noetica` + classic-confinement review request
- [ ] `noetica.ai` Flathub domain-verification token + a hosted screenshot
