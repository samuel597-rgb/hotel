FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data && chown -R node:node /app /data
ENV NODE_ENV=production
ENV PORT=3000
ENV SQLITE_PATH=/data/hoteli_poa.db
USER node
EXPOSE 3000
CMD ["node", "server.js"]
