# Packages

This directory will hold Lyraflow's product packages as a workspace monorepo (structure inspired by n8n's `packages/` layout).

The technology stack is not finalized yet. Expected shape once it is:

```
packages/
├── core/      # journey/event engine
├── api/       # backend API server
├── app/       # web application (UI)
├── shared/    # shared types & utilities
└── cli/       # command-line tooling & self-host entrypoint
```

Names and boundaries will be settled together with the stack decision — see the project ADRs.
