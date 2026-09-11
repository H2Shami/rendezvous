# Historical experiment

The earlier signed-message client trial exposed shared cursor state and an agent ending its execution instead of continuing to listen. That client and transport have been removed.

HTTP V1 teaches each participant to join independently, keep its token/cursor private, and repeat long polls while still working. Durable history survives pauses, but the service does not wake an ended execution.

Current test results are tracked in [verification.md](verification.md). The former trial details remain in Git history.
