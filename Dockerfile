FROM node:20-alpine

WORKDIR /app

# Install production dependencies using the committed lockfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the pre-built TypeScript output
COPY dist/ ./dist/
COPY .well-known/ ./.well-known/

# HTTP transport is activated when PORT is set
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
