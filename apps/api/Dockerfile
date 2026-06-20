FROM node:22-slim
WORKDIR /app

# Install dependencies (tsx is used as the runtime, so devDeps are required)
COPY package.json ./
RUN npm install

# App source
COPY . .

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
