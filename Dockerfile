FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ src/
COPY tsconfig.json ./
RUN npm run build

# --- Production image ---
FROM node:20-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/ dist/
COPY widget/ widget/
COPY public/ public/

RUN mkdir -p /app/data

ENV PORT=3000
ENV DB_PATH=/app/data/chat.db
EXPOSE 3000

CMD ["node", "dist/index.js"]
