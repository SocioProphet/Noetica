# Noetica distribution playbook

Every channel we ship (or want to ship) Noetica through, its current state, the exact steps
to publish, and — importantly — **which steps need a human account/secret that CI can't do**.

App identity:
- **Tauri bundle id:** `ai.noetica.app` (used inside the app; do not change lightly).
- **Store app id (Flathub/AppStream/Snap):** `ai.socioprophet.Noetica` — the reverse-DNS of
  `socioprophet.ai`, a domain we control. (We do NOT own `noetica.ai`, and Flathub forbids
  IDs ending in `.app`, so the store id must differ from the bundle id `ai.noetica.app`.)
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
| **apt/dnf repo** (`apt install noetica`) | ✅ **LIVE** (v0.4.24 published 2026-07-28) | **Fully sovereign** (no GitHub in the publish path): signed apt+dnf repo published by **Cloud Build** (`packaging/linux/repo/cloudbuild.yaml`) to `gs://socioprophet-noetica-apt` (`https://storage.googleapis.com/socioprophet-noetica-apt/`). Runs as the bucket-scoped `noetica-apt-publisher` SA; signs with the Secret Manager key (`noetica-repo-gpg-private`, fpr `F2A5E76E…652CEAD9`). **Per release:** `gcloud builds submit --no-source --config=packaging/linux/repo/cloudbuild.yaml --service-account=projects/socioprophet-platform/serviceAccounts/noetica-apt-publisher@socioprophet-platform.iam.gserviceaccount.com --substitutions=_TAG=vX.Y.Z,_VER=X.Y.Z`. Gotcha for fresh projects: a misleading "caller needs serviceUsageConsumer" error from Cloud Build = the **service agent isn't provisioned** (`gcloud beta services identity create --service=cloudbuild.googleapis.com` + grant it `roles/cloudbuild.serviceAgent`); rsync also needs `roles/storage.legacyBucketReader` on the SA. Later: front with `apt.socioprophet.ai` via LB; auto-trigger per stable release. |
| **AUR** (`noetica-bin`) | 🟡 ready | `packaging/linux/aur/PKGBUILD` installs from the release `.deb`. Fill the real `sha256sums` (`updpkgsums`), `makepkg --printsrcinfo > .SRCINFO`, then `git push` to `ssh://aur@aur.archlinux.org/noetica-bin.git`. **Needs:** an AUR account + SSH key. |

## Linux — app stores (harder; sandbox + approval)

| Channel | State | Steps / blocker |
|---|---|---|
| **Snap Store** | 🟡 scaffold | `packaging/linux/snap/snapcraft.yaml` rewritten as the **desktop app** on `classic` confinement (strict can't run the downloaded model runtime / GPU). **Needs:** (1) `snapcraft register noetica` (name is globally unique — grab it), (2) a **manual classic-confinement review** request on forum.snapcraft.io, (3) a local `snapcraft --use-lxd` build to validate, (4) `snapcraft upload`. Not yet build-tested. |
| **Flathub** | 🔴 real work | `metainfo` + `.desktop` are Flathub-compliant now (`ai.socioprophet.Noetica`). Remaining: (a) **verify `socioprophet.ai`** via `https://socioprophet.ai/.well-known/org.flathub.VerifiedApps.txt`; (b) rework the manifest so the **model-runtime-download + sidecar exec** works inside the Flatpak sandbox (bundle the runtime or ship as an extension) — this is the actual project; (c) host ≥1 real **screenshot**; (d) read the **Generative-AI policy** (Noetica is an AI app — real rejection risk); (e) PR to `flathub/flathub` (`new-pr` branch). |

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
- [ ] `socioprophet.ai` Flathub domain-verification token + a hosted screenshot

---

## Install on Linux (once `linux-repo.yml` has run)

**Debian / Ubuntu (apt):**
```sh
curl -fsSL https://storage.googleapis.com/socioprophet-noetica-apt/noetica-archive-keyring.asc \
  | sudo gpg --dearmor -o /usr/share/keyrings/noetica-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/noetica-archive-keyring.gpg] https://storage.googleapis.com/socioprophet-noetica-apt/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/noetica.list
sudo apt update && sudo apt install noetica
```

**Fedora / RHEL (dnf):**
```sh
sudo curl -fsSL https://storage.googleapis.com/socioprophet-noetica-apt/noetica.repo \
  -o /etc/yum.repos.d/noetica.repo
sudo dnf install noetica
```

The repo is signed; the key fingerprint is `F2A5 E76E 99D4 7731 2A8C  6293 ACDA E77B 652C EAD9`.
