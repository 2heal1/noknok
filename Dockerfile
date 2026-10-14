FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web
COPY --chown=node:node skills ./skills
COPY --chown=node:node poc ./poc
COPY --chown=node:node deploy ./deploy
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4317/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "bin/noknok.mjs"]
CMD ["server", "--host", "0.0.0.0"]
