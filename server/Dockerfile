# Brandon server — Node 22 (required by node:sqlite's DatabaseSync).
# Built from the REPO ROOT so the npm workspace + @brandon/shared resolve:
#   docker build -f server/Dockerfile -t brandon-server .
FROM node:22-slim

WORKDIR /app

# Workspace manifests first for better layer caching.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
# The client isn't needed at runtime; install only shared + server workspaces.
RUN npm ci --omit=dev --workspace server --workspace shared --include-workspace-root

# Source.
COPY shared ./shared
COPY server ./server

ENV NODE_ENV=production
ENV BRANDON_HOST=0.0.0.0
ENV PORT=8787
# Persist the SQLite DB, uploads, and JWT secret across restarts.
ENV BRANDON_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8787
WORKDIR /app/server
CMD ["npm", "run", "start"]
