FROM node:20-alpine

RUN adduser -D -H -u 10001 runner
USER runner

# Disable npm at runtime — user code shouldn't be installing packages
# inside the sandbox. If you need package support, build a curated image
# with the deps already installed.
ENV NPM_CONFIG_LOGLEVEL=silent
