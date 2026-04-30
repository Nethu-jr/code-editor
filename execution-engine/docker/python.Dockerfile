# The execution engine pulls these public images directly via `docker run`,
# but you can pre-build hardened versions of them and push to your private
# registry to (a) speed cold starts and (b) pin known-good versions.
#
# Build with: docker build -f python.Dockerfile -t collab-runner-python:3.12 .
FROM python:3.12-alpine

# Drop to a non-root user inside the image so even if the seccomp profile
# is misconfigured at runtime, the process can't escalate.
RUN adduser -D -H -u 10001 runner
USER runner

# No CMD — the engine supplies the command at `docker run` time.
