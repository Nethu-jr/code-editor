# The execution engine spawns Docker containers itself, so it needs the
# docker CLI available AND the Docker socket mounted in (see compose).
#
# SECURITY NOTE: mounting /var/run/docker.sock into a container effectively
# grants root on the host. In production, replace this with:
#   1. A dedicated docker-in-docker daemon, OR
#   2. sysbox-runc / Kata containers with proper rootless support, OR
#   3. A remote build/run service (e.g. Firecracker via firecracker-containerd)
# We use the socket-mount pattern here because it's the simplest demo.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src

EXPOSE 7000
CMD ["node", "src/runner.js"]
