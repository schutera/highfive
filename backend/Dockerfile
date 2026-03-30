FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm install

# Create images directory
RUN mkdir -p /app/images

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Remove dev dependencies and source files to reduce image size
RUN npm prune --production && rm -rf src tsconfig.json

# Expose port
EXPOSE 3001

# Note: Set HIGHFIVE_API_KEY environment variable when running
# docker run -e HIGHFIVE_API_KEY=your_secure_key backend-image

# Start server
CMD ["node", "dist/server.js"]