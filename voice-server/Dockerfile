FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY assets/ ./assets/
# HTTP API
EXPOSE 3000
# SIP UDP
EXPOSE 5060/udp
# RTP UDP range
EXPOSE 10000-20000/udp
USER app
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O- http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]
