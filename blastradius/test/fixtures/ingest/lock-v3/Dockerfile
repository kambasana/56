# syntax=docker/dockerfile:1
ARG NODE_VERSION=20.11.1
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts \
    && npm run build
COPY --from=ghcr.io/acme/assets:1.2.3 /assets /app/assets

FROM gcr.io/distroless/nodejs20-debian12@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
COPY --from=build /app/dist /app
CMD ["/app/server.js"]
