# Stage 1: build the static bundle
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
# VITE_* env vars are baked at build time, so set them via build-args.
ARG VITE_API_URL
ARG VITE_WS_URL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
RUN npm run build

# Stage 2: serve with nginx
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Single-page app: rewrite everything to index.html so deep links work.
RUN echo 'server { \
  listen 80; \
  location / { root /usr/share/nginx/html; try_files $uri /index.html; } \
}' > /etc/nginx/conf.d/default.conf
EXPOSE 80
