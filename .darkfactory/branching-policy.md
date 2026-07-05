# DarkFactory Branching Policy

Managed repositories use `dev` as the integration branch and `main` as the release branch.

- Work pull requests target `dev`.
- `dev` to `main` pull requests are releases only.
- Merging to `main` should correspond to tag and GitHub release automation where the repository ships releases.
- Data repositories, the umbrella repository, and workspace repositories may commit continuously on `main` when they are used as canonical state rather than product code.

This is the owner-mandated model tracked by `marius-patrik/agent-darkfactory#17`.
