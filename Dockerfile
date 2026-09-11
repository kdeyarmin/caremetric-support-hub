FROM node:24-alpine AS build
WORKDIR /app
ARG VITE_DEMO_MODE
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_HELP_BASE_URL
ARG VITE_PENNTRAIN_BASE_URL
ARG SUPPORT_HUB_ALLOW_DEMO_BUILD
ENV VITE_DEMO_MODE=${VITE_DEMO_MODE}
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_PUBLISHABLE_KEY=${VITE_SUPABASE_PUBLISHABLE_KEY}
ENV VITE_HELP_BASE_URL=${VITE_HELP_BASE_URL}
ENV VITE_PENNTRAIN_BASE_URL=${VITE_PENNTRAIN_BASE_URL}
ENV SUPPORT_HUB_ALLOW_DEMO_BUILD=${SUPPORT_HUB_ALLOW_DEMO_BUILD}
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/lib/backendContract.ts ./src/lib/backendContract.ts
COPY --from=build /app/supabase/functions/_shared ./supabase/functions/_shared
COPY --from=build /app/src/learning/receiptProtocol.ts /app/src/learning/receiptCoordinator.ts /app/src/learning/authoringProtocol.ts ./src/learning/
COPY --from=build /app/src/imports/publicationImportPreview.ts /app/src/imports/publicationProtocol.ts /app/src/imports/governedLearningImport.ts ./src/imports/
USER node
EXPOSE 8080
CMD ["node", "server/main.mjs"]
