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
| winget | ✅ **first submission OPEN** | [microsoft/winget-pkgs#409113](https://github.com/microsoft/winget-pkgs/pull/409113) — full 1.6-schema manifest trio for `SocioProphet.Noetica` 0.4.24 (authored at `packaging/windows/winget/manifests/…`, sha256 from the published exe, fork pushed via API). **Watch the PR for moderation feedback.** Once merged, CI's `wingetcreate update` owns every release (still needs a `WINGET_PAT` secret for that job). |
| Chocolatey | 🟡 | `packaging/chocolatey/` nuspec + scripts exist, stale at 0.4.11. Bump to 0.4.24, `choco pack`, `choco push`. **Needs:** a Chocolatey API key + the one-time package approval. |

## Linux — no-sandbox channels (do these first; best effort:reward)

| Channel | State | Steps / blocker |
|---|---|---|
| Direct `.deb` / `.rpm` | ✅ live | Built + attached by `release.yml`. |
| **apt/dnf repo** (`apt install noetica`) | ✅ **LIVE** (v0.4.24 published 2026-07-28) | **Fully sovereign** (no GitHub in the publish path): signed apt+dnf repo published by **Cloud Build** (`packaging/linux/repo/cloudbuild.yaml`) to `gs://socioprophet-noetica-apt` (`https://storage.googleapis.com/socioprophet-noetica-apt/`). Runs as the bucket-scoped `noetica-apt-publisher` SA; signs with the Secret Manager key (`noetica-repo-gpg-private`, fpr `F2A5E76E…652CEAD9`). **Per release:** `gcloud builds submit --no-source --config=packaging/linux/repo/cloudbuild.yaml --service-account=projects/socioprophet-platform/serviceAccounts/noetica-apt-publisher@socioprophet-platform.iam.gserviceaccount.com --substitutions=_TAG=vX.Y.Z,_VER=X.Y.Z`. Gotcha for fresh projects: a misleading "caller needs serviceUsageConsumer" error from Cloud Build = the **service agent isn't provisioned** (`gcloud beta services identity create --service=cloudbuild.googleapis.com` + grant it `roles/cloudbuild.serviceAgent`); rsync also needs `roles/storage.legacyBucketReader` on the SA. Later: front with `apt.socioprophet.ai` via LB; auto-trigger per stable release. |
| **AUR** (`noetica-bin`) | ✅ ready-to-push | `PKGBUILD` sha256 pinned to the published v0.4.24 deb + `.SRCINFO` authored. Only remaining step: create an AUR account + SSH key, then `git push` both files to `ssh://aur@aur.archlinux.org/noetica-bin.git`. |

## Linux — app stores (harder; sandbox + approval)

| Channel | State | Steps / blocker |
|---|---|---|
| **Snap Store** | 🟡 scaffold | `packaging/linux/snap/snapcraft.yaml` rewritten as the **desktop app** on `classic` confinement (strict can't run the downloaded model runtime / GPU). **Needs:** (1) `snapcraft register noetica` (name is globally unique — grab it), (2) a **manual classic-confinement review** request on forum.snapcraft.io, (3) a local `snapcraft --use-lxd` build to validate, (4) `snapcraft upload`. Not yet build-tested. |
| **Flathub** | 🟡 manifest ready — 2 blockers | Full manifest at `packaging/linux/flatpak/ai.socioprophet.Noetica.yml`: extra-data over the released deb (real sha256), freedesktop 24.08, sandbox args for Tauri/WebKitGTK + on-device models (HOME remap keeps `~/.noetica` runtime downloads inside the sandbox); `update-manifest.sh` bumps per release. **Blockers, both hosting:** (a) **`socioprophet.ai` serves NO HTTPS today** (Namecheap DNS, apex → URL-forward IP, 443 dead) — domain verification needs `https://socioprophet.ai/.well-known/org.flathub.VerifiedApps.txt`; (b) a real **screenshot** at a live URL (can host on the GCS bucket now). Then: read the Generative-AI policy, fork `flathub/flathub`, branch off `new-pr`, add manifest+flathub.json, PR `Add ai.socioprophet.Noetica`. |

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

## DNS / hosting for the store identity (decision needed)

Findings (2026-07-28): `socioprophet.ai` DNS is at **Namecheap** (registrar-servers NS); the
apex A record points at Namecheap's URL-forward IP (`192.64.119.226`) and **HTTPS (443) does
not connect at all**. The app id `ai.socioprophet.Noetica` needs no DNS record per se — but
Flathub verification fetches `https://socioprophet.ai/.well-known/org.flathub.VerifiedApps.txt`,
so the apex must serve HTTPS static files. Options:

1. **Firebase Hosting** (recommended fast path): free HTTPS + custom domain, serves
   `.well-known/` + `/screenshots/`; estate already uses Firebase for web auth. Namecheap
   change: apex A records → Firebase IPs.
2. **GCLB + GCS bucket**: fully sovereign-static, ~$18/mo LB + managed cert; also enables the
   branded `apt.socioprophet.ai` repo URL later.
3. Point apex at the existing GKE web ingress (socioprophet-web) and serve statics from it —
   most integrated, needs the .ai prod-surface decision ([.ai = agentic surface] per plan).

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
