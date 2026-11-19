FROM node:20-alpine AS build
WORKDIR /app
# better-sqlite3 needs a native build toolchain at install time only.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p /app/data && addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
ENV DB_PATH=/app/data/cache.db
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["node", "src/server.js"]
