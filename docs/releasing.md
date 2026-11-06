# Release procedure

The prepared version is Python `0.2.0rc1` / JavaScript `0.2.0-rc.1`. Distribution names
`otpigeon-server` and `otpigeon-sdk` are candidates; ownership/availability in registries
must be confirmed before first publication. No registry credential is required to build.

1. Review the exact PR revision and CI. Read `docs/verification/release-0.2.md` for evidence
   and remaining coverage. Review the MIT license before merging the first public release.
2. Install development requirements. Run the complete required tests/audits/build checks
   from README and the CI workflow against disposable state, including provider fixtures.
3. Build with `python -m build`, validate `twine check dist/*`, and install the wheel in a
   clean venv. Verify `otpigeon --version`, packaged dashboard assets, init preserving an
   existing file, and a full mock request/worker/verify flow from that installation.
4. Build `npm pack ./sdk --pack-destination .local`; install the tarball in a new Node project,
   verify ESM import and TypeScript types, and run a mock end-to-end flow against the gateway.
5. Build/run the container topology; check fresh setup, both workers and APIs, process failure
   recovery, and API/worker logs without secrets. Generate checksums and inspect artifacts
   for environment files, real keys, auth sessions, test data, or experimental Node code.
6. In a separately authorized staging environment, configure the operator's real provider,
   supported version/template and callback origin, send to a consenting recipient, confirm
   signed receipt delivery, and verify the code. Check provider billing/account restrictions.
7. With explicit release authorization and confirmed registry ownership, publish reviewed
   artifacts to PyPI/npm, tag the matching revision, and create a GitHub release with hashes,
   migration notes and coverage limits. Never publish automatically from a pull request.

Rollback: preserve the database and matching root secret, stop live workers, and restore the
previous tested application image/revision. Never reset dispatched/unknown jobs to queued.
The M1 application cannot operate the new live-provider queue; disable live traffic during
such a rollback. Keep backups until the migration and controlled delivery have been verified.
