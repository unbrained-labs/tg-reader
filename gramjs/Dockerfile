FROM node:20-alpine

WORKDIR /app

# Copy manifests first for layer caching — npm ci runs before source copy
COPY package.json package-lock.json* ./

# Install all dependencies including devDeps (ts-node + typescript required at runtime)
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

# Ensure persistent volume mount point exists (Fly mounts tg_state volume here)
RUN mkdir -p /data

CMD ["./node_modules/.bin/ts-node", "src/listener.ts"]
