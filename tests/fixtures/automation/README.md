# Automation fixtures

These fixtures model pipeline state rather than product content. Tests create temporary
item roots at runtime so no production SKU or generated image is modified.

The important regression is an existing `work/items/<SKU>` directory that lacks one
or more required artifacts. Directory presence alone must never yield
`SKIPPED_COMPLETE`.
