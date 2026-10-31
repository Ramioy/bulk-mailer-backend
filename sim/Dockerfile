# Simulation image (branch `simulacion`): the application, the simulators and the scenario runner.
# Built from the repository after `pnpm install && pnpm build` on the host (node_modules and dist are copied).
FROM node:26-slim
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY node_modules ./node_modules
COPY dist ./dist
COPY mocks ./mocks
COPY sim/*.ts sim/package.json ./sim/
COPY deploy ./deploy
ENV NODE_ENV=production
