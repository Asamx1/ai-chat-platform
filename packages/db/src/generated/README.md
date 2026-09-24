# Prisma client prerequisite

The orchestrator must apply `20260926000000_vault_inferred` and regenerate the Prisma client from `packages/db/prisma/schema.prisma` before type checking or executing the new inference persistence code. Generated client sources were intentionally not edited or regenerated for this task. The new delegate is `vaultInferredAssertion`.
