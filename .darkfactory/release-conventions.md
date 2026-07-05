# DarkFactory Release Conventions

- Release pull requests are `dev` to `main`.
- Release tags use `v*.*.*`.
- Managed release workflow validates before creating a GitHub release.
- Repositories with binaries, installers, containers, or generated artifacts should add build and smoke scripts so release validation exercises the shipped artifact.
- Product work does not merge directly to `main`; it lands on `dev` first and is released deliberately.
