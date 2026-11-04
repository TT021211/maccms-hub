FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY test ./test
EXPOSE 3001
ENV PORT=3001 CACHE_TTL=7200
VOLUME ["/tmp/hls"]
CMD ["node", "src/server.js"]
