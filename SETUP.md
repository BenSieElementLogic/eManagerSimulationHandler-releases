# One-time setup for the public demo mirror

The private repo's `release.yml` already contains a **secret-gated** "Mirror to public demo repo" step.
It does nothing until the steps below are done, then activates automatically on the next release.

## 1. Create the public repo

Create a **public** repo named **`eManagerSimulationHandler-releases`** under the `BenSieElementLogic`
account, then push the contents of this `demo-repo/` folder to it as the initial commit:

```bash
# from a clean checkout of demo-repo/ contents:
gh repo create BenSieElementLogic/eManagerSimulationHandler-releases --public --disable-issues
git init && git add . && git commit -m "chore: public demo mirror scaffold"
git branch -M main
git remote add origin https://github.com/BenSieElementLogic/eManagerSimulationHandler-releases.git
git push -u origin main
```

## 2. Enable GitHub Pages on the public repo

Settings → Pages → **Source: GitHub Actions**. (Public repo ⇒ Pages is free.)
The `pages.yml` here builds the landing page on push, on `release: published`, and on demand.

## 3. Create a token the private repo can use to publish releases here

Create a **fine-grained PAT** scoped to **only** `eManagerSimulationHandler-releases` with
repository permissions: **Contents: Read and write** (needed to create releases + tags).
(Settings → Developer settings → Fine-grained tokens.)

## 4. Store it as a secret in the PRIVATE repo

```bash
gh secret set DEMO_SECRETE --repo BenSieElementLogic/eManagerSimulationHandler --body "<the PAT>"
```

## Done

On the next `main` push (rolling `latest`) or `v*` tag, the private CI builds the **mock-included** demo
zips and creates a matching release in this public repo, which triggers the Pages rebuild here.
No source code is ever copied — only the built binaries and the generated landing page.
