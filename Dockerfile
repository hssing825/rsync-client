FROM node:18-slim

RUN apt-get update && apt-get install -y rsync && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY src/ ./src/

RUN mkdir -p /app/data /app/webdav-storage

EXPOSE 3000

VOLUME ["/app/data", "/app/webdav-storage"]

CMD ["node", "src/server.js"]