FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN node scripts/build-hosting.js
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/tmp/hoteli_poa.db
EXPOSE 3000
CMD ["node", "server/index.js"]
