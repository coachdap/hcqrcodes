FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    QRGEN_LOGO_DIR=/output/logos

WORKDIR /app

# Dependencies first, so source edits don't invalidate the install layer.
# sharp ships prebuilt linux glibc binaries, so no build toolchain is needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY bin ./bin
COPY test ./test
COPY assets ./assets
COPY public ./public
COPY client.js ./client.js

# node:22-slim ships an unprivileged `node` user (uid 1000); run as it, not root.
RUN mkdir -p /output/logos && chown -R node:node /output /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
