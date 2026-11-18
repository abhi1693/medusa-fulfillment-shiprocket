FROM node:24.21.0-bookworm-slim AS testing
RUN npm install --global npm@12.2.2
WORKDIR /plugin
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm test && npm run build && npm run check:package
CMD ["node", "scripts/check-tarball.mjs"]
