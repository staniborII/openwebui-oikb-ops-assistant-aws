# Image for the sidecar that copies oikb sync metrics into CloudWatch.
# Dependencies are installed on Alpine. The running image is distroless Node,
# which does not ship the npm tree that node:22-alpine is flagged for.
FROM public.ecr.aws/docker/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY readings.js server.js ./
CMD ["server.js"]
