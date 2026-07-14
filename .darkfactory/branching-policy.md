# DarkFactory Branching Policy

Managed code repositories use `dev` for work integration and `main` for the
canonical Agent OS product state.

- Work pull requests target `dev`.
- Agent OS integration pull requests move reviewed `dev` state to `main`.
- Component repositories do not define independent version, tag, or release authority.
- State and data repositories may commit directly to `main` when their own policy permits it.

This policy is owned by the canonical `marius-patrik/agents-manager` source repository.
