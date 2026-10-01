FROM node:24-alpine AS dependencies
WORKDIR /app
RUN chown node:node /app
COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci --no-audit --no-fund

FROM dependencies AS runtime
COPY --chown=node:node . .
USER node
EXPOSE 3001
CMD ["npm", "run", "api"]

FROM dependencies AS web-build
COPY . .
RUN npm run build

FROM nginx:1.28-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/dist/web /usr/share/nginx/html
EXPOSE 80
