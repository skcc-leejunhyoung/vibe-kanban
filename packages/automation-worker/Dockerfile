FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV AUTOMATION_DATA_DIR=/data

COPY packages/automation-worker/package.json ./package.json
COPY packages/automation-worker/src ./src

EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "src/server.mjs"]
