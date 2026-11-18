# Gabi's Router

[![CI](https://github.com/gabisurita/gabis-router/actions/workflows/ci.yml/badge.svg)](https://github.com/gabisurita/gabis-router/actions/workflows/ci.yml)

<p align="center">
  <img src="web/public/logo.png" width="110" alt="Gabi's Router logo" />
</p>

Gabi's Router is a customizable cycling route planner powered by [BRouter](https://brouter.de) and [`brouter-rs`](https://github.com/gabisurita/brouter-rs). It runs in your browser via WebAssembly and works offline. It is fully free, private, and open-source, with no accounts or tracking. Try it at [router.surita.dev](https://router.surita.dev).

> [!WARNING]
> This project is highly experimental. Routes are generated from OpenStreetMap data and may contain errors, closed paths, or unsafe roads. Always check road signs and conditions on the ground.

## What It Does

| Capability | Description |
| :--- | :--- |
| Custom routing | Score every road by surface, traffic, speed limit, noise, hills, and road class. |
| Side-by-side comparison | Compare up to three routing profiles or independent routes on the map at once. |
| Surface and road breakdown | Inspect distance shares for surfaces, road types, traffic levels, noise, and route warnings. |
| Offline mode | Download routing segments and vector map tiles once to plan routes without internet access. |
| GPX import and export | Import existing GPX tracks to match onto the road network, or export planned rides to GPX. |

## Quick Start

Build the WebAssembly bindings and start the web app:

```bash
npm --prefix web install
npm --prefix web run build:wasm
npm --prefix web run dev
```

Run tests:

```bash
cargo test
npm --prefix web test
```

## Documentation

| Guide | Contents |
| :--- | :--- |
| [web/README.md](web/README.md) | Web app setup and frontend structure. |
| [`brouter-rs`](https://github.com/gabisurita/brouter-rs) | Core Rust routing engine and CLI tools. |
| [tools/README.md](tools/README.md) | Data scripts and development tools. |
