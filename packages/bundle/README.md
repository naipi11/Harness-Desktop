# bundle/ — profile plugin bundles

English | [中文](README.zh.md)

Internal profile bundles are npm packages whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, making them patch layers for Runtime/app-boot compositions ([profile contract](../boot/app-boot/README.md#profiles)). A bundle's substance is its patch list; some also ship runtime glue plugins their patch mounts. The public CLI exposes no profile installation or boot command.

| Package | Role | ctx key |
|---|---|---|
| [`base/`](base/README.md) | The shared dsh core every profile applies first | — (patch only) |
| [`web-app/`](web-app/README.md) | Browser surface: web patch layer + runtime glue plugin | mounts rows |
| [`headless/`](headless/README.md) | Direct one-shot task mode over base, with no Host or Web layer | mounts `headless-runner` |

In-box bundles resolve from the dsh installation; internal deployment provisioning owns any out-of-tree bundle installation.
