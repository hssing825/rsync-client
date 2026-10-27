FROM node:18-slim

RUN apt-get update && apt-get install -y rsync && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY src/ ./src/

RUN mkdir -p /app/data /app/webdav-storage /app/logs

EXPOSE 3002

VOLUME ["/app/data", "/app/webdav-storage", "/app/logs"]

CMD ["node", "src/server.js"]