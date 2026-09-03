FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    QRGEN_LOGO_DIR=/output/logos

WORKDIR /app

# The SVG converter rasterises <text> with whatever fonts the image has, and a
# slim image has none. Liberation covers Arial/Helvetica/Times/Courier by metric
# and DejaVu the generic families, which is enough for flyer and logo SVGs.
# Convert text to outlines in the source for exact fidelity.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-liberation fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# Dependencies first, so source edits don't invalidate the install layer.
# sharp and resvg ship prebuilt linux glibc binaries, so no build toolchain is needed.
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
