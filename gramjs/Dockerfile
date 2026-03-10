FROM node:20-alpine

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json tsconfig.json ./

# Install all dependencies (typescript needed for build)
RUN npm install

# Copy source and compile to JS
COPY src/ ./src/
RUN ./node_modules/.bin/tsc --outDir dist

# Ensure persistent volume mount point exists (Fly mounts tg_state volume here)
RUN mkdir -p /data

CMD ["node", "dist/listener.js"]
