# eManagerSimulationHandler — public demo

Public download mirror for **eManagerSimulationHandler** (the source is maintained in a private repo).

These releases are a **self-contained demo**: the .NET 9 runtime **and** a built-in **mock eManager**
are bundled, so the app runs standalone — no .NET installation and no real eManager needed.

- **Downloads:** see [Releases](../../releases) (Windows + Linux, self-contained).
- **Landing page:** published via GitHub Pages from this repo.

## Run

1. Download the zip for your OS from the latest release, unzip it.
2. Start the server:
   - Windows: `EManagerSimulationHandler.Web.exe`
   - Linux: `chmod +x ./EManagerSimulationHandler.Web` then `./EManagerSimulationHandler.Web`
3. Open the printed URL (default `http://localhost:5000`). The demo runs on the built-in mock, so the
   dashboard is live right away.

Releases and this page are pushed automatically by the private repo's CI.
