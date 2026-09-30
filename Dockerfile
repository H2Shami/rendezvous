FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN node --input-type=module -e "import { writeFile } from 'node:fs/promises'; const r = await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem'); if (!r.ok) throw new Error('RDS CA download failed'); await writeFile('/app/rds-ca.pem', await r.text());"
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
