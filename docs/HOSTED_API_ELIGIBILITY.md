# NVIDIA hosted API eligibility

Audit date: 2026-08-19. Release classification: **PUBLIC_BETA**. Public inference eligibility: **BLOCKED under Trial Terms**.

NVIDIA's official GLM-5.2 page says the model itself is ready for commercial or non-commercial use, but separately identifies the hosted endpoint as a trial service governed by the NVIDIA API Trial Terms. These are different legal layers.

The current Trial Terms state:

- §1.2: access is for limited trial purposes only and excludes production use of the API service or generated content.
- §1.4: without a NVIDIA or service-provider subscription, use is only for internal testing and evaluation, not production.
- §1.4: a separate subscription is required for production use.

Therefore a maintainer trial key is not sufficient evidence for an anonymous public shared inference service. AgentRoom may be built, tested with mocks, and privately smoke-tested, but the public NVIDIA path must remain disabled until the maintainer can document subscription/partner terms that permit this serving pattern. This is a release blocker, not a software defect, and it must not be hidden behind a “Beta” label.

Official sources:

- [NVIDIA Build GLM-5.2](https://build.nvidia.com/z-ai/glm-5.2)
- [NVIDIA API Trial Terms of Service](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf)

Required evidence before enabling public inference:

1. Applicable subscription or service-provider terms explicitly permit public serving.
2. Deployment-scoped key is installed only as a Cloudflare secret.
3. Account quota and observed RPM are verified with a small smoke test.
4. Model and hosted terms remain compatible on release day.

