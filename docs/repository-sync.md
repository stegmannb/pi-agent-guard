# Repository synchronization

Forgejo is the canonical development platform. An external coordinator checks
GitHub every hour and publishes canonical Forgejo branches to GitHub using
fast-forward updates with exact destination leases.

Incoming GitHub changes create or update a Forgejo import pull request. The
synchronizer writes only its import branches. Acceptance requires the same
exact-head CI, independent Reviewers approval, and Owner merge as any other
Tier-0 contribution. Use fast-forward-only merging for imports to preserve
commit identities. The synchronizer never merges a pull request.

Pending GitHub changes remain intact while review is open. Divergent histories
need explicit reconciliation before a fast-forward merge. A closed, unmerged
proposal is not reopened for the same source commit. Ref deletion and tag
changes require Owner action; tags and GitHub release assets are not imported.

Synchronization credentials live outside this repository. Its sole Forgejo
workflow remains credentialless PR CI under the
[Forgejo Tier-0 contract](forgejo-tier-0.md).
