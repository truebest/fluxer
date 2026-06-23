FROM node:20-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
CMD ["node", "src/server.js"]
