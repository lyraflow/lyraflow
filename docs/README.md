# Lyraflow Documentation

Public product documentation: installation, self-hosting guides, concepts, and API reference will live here as the product takes shape.

For v0.1 the whole public surface is small enough to live in the top-level [README](../README.md): installing the stack, creating a project, the four ingest endpoints with their payload shape, identity resolution (`/v1/alias`, `GET /v1/persons/:id`), a segment query API for counting and listing people matching a filter tree, and per-person deletion and export (`DELETE /v1/persons/:id`, `GET /v1/persons/:id/export`). See the top-level README for the full endpoint list and payload details rather than this page — it is the one place that surface is kept current.
