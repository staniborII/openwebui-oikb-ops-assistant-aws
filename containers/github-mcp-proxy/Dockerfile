# Image for the sidecar that attaches the GitHub token.
# Distroless Node has no npm. That bundled tree is what the official
# node:22-alpine image was being flagged for.
FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
COPY server.js .
CMD ["server.js"]
