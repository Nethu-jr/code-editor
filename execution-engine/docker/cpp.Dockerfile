FROM gcc:13-bookworm-slim

# Strip apt cache to keep the image small.
RUN rm -rf /var/lib/apt/lists/*

RUN useradd -M -u 10001 runner
USER runner
