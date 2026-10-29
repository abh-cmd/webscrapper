FROM node:20-bookworm-slim AS build

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend

COPY frontend ./frontend
RUN npm --prefix frontend run build

# The crawler uses Playwright in production as well as the dashboard API.
RUN npx playwright install --with-deps chromium

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/frontend/dist ./frontend/dist
COPY src ./src
COPY public ./public
COPY db ./db
COPY input ./input
COPY scripts ./scripts
COPY package.json ./
COPY deploy/docker-entrypoint.sh ./deploy/docker-entrypoint.sh

RUN mkdir -p output/images output/raw output/reports output/results \
  && chmod +x deploy/docker-entrypoint.sh

EXPOSE 3100
ENTRYPOINT ["./deploy/docker-entrypoint.sh"]
