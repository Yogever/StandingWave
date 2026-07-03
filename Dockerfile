FROM node:22-alpine

# ffmpeg is the recording engine
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public
COPY config ./config

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

VOLUME /data
EXPOSE 8080

CMD ["node", "server/index.js"]
