FROM node:22-alpine
WORKDIR /app
# the data folder is created and owned by the unprivileged user, so the named volume inherits that ownership
RUN mkdir /data && chown node:node /data
COPY server.js ./
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
